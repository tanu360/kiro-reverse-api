/** Recorded run time per test file in milliseconds, keyed by the path from ui/ with `/` separators. */
export type TestTimings = Readonly<Record<string, number>>;

/**
 * Splits test files into `count` shards of near-equal recorded run time, longest file first, each
 * into the shard with the least time so far (ties go to the lower shard). A file without a recorded
 * time counts as the average of the recorded ones.
 *
 * The plan depends only on the file list and the timings, so every CI shard computes the same plan
 * and each file runs in exactly one shard. Stale timings only make the shards less even; they never
 * drop or repeat a file.
 */
export function planShards(
  files: readonly string[],
  timings: TestTimings,
  count: number,
): string[][] {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`shard count must be a positive integer, got ${count}`);
  }
  const weight = timingWeights(files, timings);
  const ordered = [...new Set(files)].sort(
    (a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], total: 0 }));
  for (const file of ordered) {
    let target = shards[0];
    for (const shard of shards) {
      if (shard.total < target.total) target = shard;
    }
    target.files.push(file);
    target.total += weight(file);
  }
  return shards.map((shard) => shard.files);
}

/** The recorded time of each file, or the average recorded time for a file with none. */
export function timingWeights(
  files: readonly string[],
  timings: TestTimings,
): (file: string) => number {
  const recorded = (file: string): number | undefined => {
    const time = Object.hasOwn(timings, file) ? timings[file] : undefined;
    return typeof time === "number" && Number.isFinite(time) && time > 0 ? time : undefined;
  };
  const known = files.map(recorded).filter((time): time is number => time !== undefined);
  const fallback = known.length > 0 ? known.reduce((sum, time) => sum + time, 0) / known.length : 1;
  return (file) => recorded(file) ?? fallback;
}
