// Vitest's own sharding (`--shard=i/n`) splits test files by count, so one shard can draw every
// slow page test while another finishes early. TimedSequencer splits them by the run time each file
// took last time it was recorded (src/test/test-timings.json), so CI's shards finish together, and
// starts the slowest files first so no worker picks up a long file at the end.
//
// Refresh the timings after adding or reshaping slow tests: `pnpm test:timings` runs the suite and
// rewrites the file through TimingsReporter below. Stale timings only make the shards less even.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Reporter, TestModule, TestSpecification } from "vitest/node";
import { BaseSequencer } from "vitest/node";
import { planShards, type TestTimings, timingWeights } from "./src/test/shard-plan";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const timingsFile = path.join(rootDir, "src/test/test-timings.json");

function readTimings(): TestTimings {
  if (!existsSync(timingsFile)) return {};
  return JSON.parse(readFileSync(timingsFile, "utf8")) as TestTimings;
}

/** The key a file has in the timings: its path from ui/, with `/` separators. */
function timingKey(moduleId: string): string {
  return path.relative(rootDir, moduleId).split(path.sep).join("/");
}

export class TimedSequencer extends BaseSequencer {
  private readonly timings = readTimings();

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { shard } = this.ctx.config;
    if (!shard) return files;
    const byKey = new Map<string, TestSpecification[]>();
    for (const spec of files) {
      const key = timingKey(spec.moduleId);
      byKey.set(key, [...(byKey.get(key) ?? []), spec]);
    }
    const plan = planShards([...byKey.keys()], this.timings, shard.count);
    return plan[shard.index - 1].flatMap((key) => byKey.get(key) ?? []);
  }

  // Failed files first, as Vitest does, then the slowest recorded files.
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const weight = timingWeights(
      files.map((spec) => timingKey(spec.moduleId)),
      this.timings,
    );
    const failed = (spec: TestSpecification) =>
      this.ctx.cache.getTestSpecificationResult(spec)?.failed === true;
    return [...files].sort((a, b) => {
      const failedDiff = Number(failed(b)) - Number(failed(a));
      if (failedDiff !== 0) return failedDiff;
      const keyA = timingKey(a.moduleId);
      const keyB = timingKey(b.moduleId);
      return weight(keyB) - weight(keyA) || (keyA < keyB ? -1 : keyA > keyB ? 1 : 0);
    });
  }
}

/**
 * Records how long each test file took, from environment setup to its last test, into
 * src/test/test-timings.json. Files this run did not cover keep their old time; files that no
 * longer exist are dropped.
 */
export default class TimingsReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const timings: Record<string, number> = {};
    for (const [key, time] of Object.entries(readTimings())) {
      if (existsSync(path.join(rootDir, key))) timings[key] = time;
    }
    for (const testModule of testModules) {
      const d = testModule.diagnostic();
      const total =
        d.environmentSetupDuration +
        d.prepareDuration +
        d.collectDuration +
        d.setupDuration +
        d.duration;
      if (total > 0) timings[timingKey(testModule.moduleId)] = Math.round(total);
    }
    const sorted = Object.fromEntries(
      Object.entries(timings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    writeFileSync(timingsFile, `${JSON.stringify(sorted, null, 2)}\n`);
  }
}
