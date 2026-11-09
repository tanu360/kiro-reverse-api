import { describe, expect, it } from "vitest";
import type { HeatmapCell, ModelMixEntry } from "@/lib/api/types";
import {
  bucketGlobal,
  bucketRetries,
  busyAccounts,
  hourDelta,
  modelSlices,
  peakCount,
  RANGE_WINDOWS,
  withPreviousWindow,
} from "./aggregate";

/** Newest-first cells: `values[i]` is offset i. */
function cells(values: Array<[reqs: number, failures: number]>): HeatmapCell[] {
  return values.map(([reqs, failures], offset) => ({ offset, reqs, failures }));
}

function zeros(count: number): HeatmapCell[] {
  return Array.from({ length: count }, (_, offset) => ({ offset, reqs: 0, failures: 0 }));
}

function model(name: string, credits: number, reqs: number): ModelMixEntry {
  return {
    model: name,
    reqs,
    inTokens: 0,
    outTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    credits,
    lastUsed: 0,
  };
}

describe("bucketGlobal", () => {
  const now = 1_700_000_000;

  it("returns oldest-first points with summed succeeded and failed counts", () => {
    // offsets 0..9: two 5-minute buckets.
    const input = cells([
      [3, 1],
      [2, 0],
      [0, 0],
      [1, 1],
      [4, 0],
      [5, 2],
      [0, 0],
      [1, 0],
      [0, 0],
      [2, 1],
    ]);
    const points = bucketGlobal(input, now, 5);
    expect(points).toHaveLength(2);
    // Oldest bucket (offsets 5-9) first: 8 requests, 3 failed.
    expect(points[0]).toEqual({
      date: new Date((now - 9 * 60) * 1000),
      succeeded: 5,
      failed: 3,
    });
    // Newest bucket (offsets 0-4): 10 requests, 2 failed.
    expect(points[1]).toEqual({
      date: new Date((now - 4 * 60) * 1000),
      succeeded: 8,
      failed: 2,
    });
  });

  it("keeps one point per minute for 1-minute buckets", () => {
    const points = bucketGlobal(zeros(60), now, 1);
    expect(points).toHaveLength(60);
    expect(points[0].date).toEqual(new Date((now - 59 * 60) * 1000));
    expect(points[59].date).toEqual(new Date(now * 1000));
  });

  it("gives 72 points for 6 h and 96 points for 24 h", () => {
    expect(bucketGlobal(zeros(360), now, 5)).toHaveLength(72);
    expect(bucketGlobal(zeros(1440), now, 15)).toHaveLength(96);
  });

  it("keeps the full time axis without cells and leaves out cells past the window", () => {
    expect(bucketGlobal([], now, 2, 60)).toHaveLength(30);
    const points = bucketGlobal(
      [
        { offset: 0, reqs: 2, failures: 0 },
        { offset: 90, reqs: 7, failures: 0 },
      ],
      now,
      2,
      60,
    );
    expect(points).toHaveLength(30);
    expect(points.reduce((sum, p) => sum + p.succeeded, 0)).toBe(2);
  });

  it("orders by offset, not by array position", () => {
    const shuffled: HeatmapCell[] = [
      { offset: 1, reqs: 4, failures: 0 },
      { offset: 0, reqs: 1, failures: 1 },
    ];
    const points = bucketGlobal(shuffled, now, 1);
    expect(points.map((p) => [p.succeeded, p.failed])).toEqual([
      [4, 0],
      [0, 1],
    ]);
  });
});

describe("bucketRetries", () => {
  it("sums retries per bucket, oldest first, and leaves cells past the window out", () => {
    const retried: HeatmapCell[] = [
      { offset: 0, reqs: 1, failures: 0, retries: 2 },
      { offset: 1, reqs: 0, failures: 0, retries: 1 },
      { offset: 3, reqs: 0, failures: 0 },
      { offset: 5, reqs: 0, failures: 0, retries: 4 },
      { offset: 6, reqs: 0, failures: 0, retries: 9 },
    ];
    expect(bucketRetries(retried, 2, 6)).toEqual([4, 0, 3]);
  });
});

describe("hourDelta", () => {
  it("compares the current hour (offsets 0-59) with the previous one (60-119)", () => {
    const input = zeros(120);
    input[0].reqs = 10;
    input[59].reqs = 5;
    input[60].reqs = 4;
    input[119].reqs = 6;
    expect(hourDelta(input)).toEqual({ current: 15, previous: 10, delta: 0.5 });
  });

  it("returns a null delta when the previous hour is 0", () => {
    const input = zeros(120);
    input[3].reqs = 7;
    expect(hourDelta(input)).toEqual({ current: 7, previous: 0, delta: null });
  });

  it("uses the value picker", () => {
    const input = zeros(120);
    input[0] = { offset: 0, reqs: 5, failures: 2 };
    input[70] = { offset: 70, reqs: 4, failures: 4 };
    expect(hourDelta(input, (cell) => cell.failures)).toEqual({
      current: 2,
      previous: 4,
      delta: -0.5,
    });
    expect(hourDelta(input, (cell) => cell.reqs - cell.failures)).toEqual({
      current: 3,
      previous: 0,
      delta: null,
    });
  });
});

describe("modelSlices", () => {
  it("keeps the top models and puts the remainder into Other", () => {
    const models = [
      model("m1", 50, 1),
      model("m2", 20, 1),
      model("m3", 10, 1),
      model("m4", 8, 1),
      model("m5", 7, 1),
      model("m6", 5, 1),
    ];
    const result = modelSlices(models, 4, "Other");
    expect(result.metric).toBe("credits");
    expect(result.total).toBe(100);
    expect(result.slices.map((s) => [s.label, s.value])).toEqual([
      ["m1", 50],
      ["m2", 20],
      ["m3", 10],
      ["m4", 8],
      ["Other", 12],
    ]);
    expect(result.slices.every((s) => s.maxValue === 100)).toBe(true);
  });

  it("has no Other slice when every model fits", () => {
    const result = modelSlices([model("m1", 3, 1), model("m2", 1, 1)], 4, "Other");
    expect(result.slices.map((s) => s.label)).toEqual(["m1", "m2"]);
  });

  it("falls back to requests when all credits are 0", () => {
    const result = modelSlices(
      [model("m1", 0, 2), model("m2", 0, 9), model("m3", 0, 4)],
      2,
      "Other",
    );
    expect(result.metric).toBe("reqs");
    expect(result.total).toBe(15);
    expect(result.slices.map((s) => [s.label, s.value])).toEqual([
      ["m2", 9],
      ["m3", 4],
      ["Other", 2],
    ]);
  });

  it("returns no slices without models", () => {
    expect(modelSlices([], 4, "Other")).toEqual({ slices: [], total: 0, metric: "reqs" });
  });
});

describe("busyAccounts", () => {
  const row = (accountId: string, cells: HeatmapCell[]) => ({ accountId, cells });

  it("keeps the server's order and an account whose attempts all failed over", () => {
    const accounts = [
      row("busy", [{ offset: 0, reqs: 12, failures: 0 }]),
      row("failing-over", [{ offset: 3, reqs: 0, failures: 0, retries: 10 }]),
      row("mid", [{ offset: 1, reqs: 4, failures: 1 }]),
    ];
    expect(busyAccounts(accounts, 60, 5).map((account) => account.accountId)).toEqual([
      "busy",
      "failing-over",
      "mid",
    ]);
  });

  it("leaves out rows without requests or failed attempts in the window and caps the count", () => {
    const accounts = [
      row("old", [{ offset: 60, reqs: 9, failures: 0, retries: 2 }]),
      row("credits-only", [{ offset: 0, reqs: 0, failures: 0, credits: 1 }]),
      row("a", [{ offset: 0, reqs: 1, failures: 0 }]),
      row("b", [{ offset: 0, reqs: 1, failures: 0 }]),
    ];
    expect(busyAccounts(accounts, 60, 1).map((account) => account.accountId)).toEqual(["a"]);
  });
});

describe("withPreviousWindow", () => {
  const now = 1_700_000_000;

  it("lays the previous hour's succeeded counts under the current hour, bucket for bucket", () => {
    const input: HeatmapCell[] = [
      { offset: 0, reqs: 3, failures: 1 },
      { offset: 59, reqs: 4, failures: 0 },
      { offset: 60, reqs: 6, failures: 2 },
      { offset: 119, reqs: 5, failures: 0 },
    ];
    const points = withPreviousWindow(input, now, 2, 60);
    expect(points).toHaveLength(30);
    // Oldest bucket: offsets 58-59 now, 118-119 an hour earlier.
    expect(points[0]).toMatchObject({ succeeded: 4, failed: 0, previous: 5 });
    // Newest bucket: offsets 0-1 now, 60-61 an hour earlier.
    expect(points[29]).toMatchObject({ succeeded: 2, failed: 1, previous: 4 });
    expect(points[0].date).toEqual(new Date((now - 59 * 60) * 1000));
  });

  it("gives a flat zero comparison without an earlier hour", () => {
    const points = withPreviousWindow([{ offset: 3, reqs: 1, failures: 0 }], now, 2, 60);
    expect(points.every((p) => p.previous === 0)).toBe(true);
  });
});

describe("peakCount", () => {
  const at = (succeeded: number, failed = 0, previous?: number) => ({
    date: new Date(0),
    succeeded,
    failed,
    previous,
  });

  it("is 0 without traffic", () => {
    expect(peakCount([])).toBe(0);
    expect(peakCount([at(0), at(0)])).toBe(0);
  });

  it("takes the busiest bucket of any series, the comparison included", () => {
    expect(peakCount([at(2), at(0, 3)])).toBe(3);
    expect(peakCount([at(9, 1, 12)])).toBe(12);
  });
});

describe("RANGE_WINDOWS", () => {
  it("buckets the 1 h view by 2 min so sparse minutes do not draw a comb", () => {
    expect(RANGE_WINDOWS["1h"]).toEqual({ windowMin: 60, bucketMin: 2 });
    expect(bucketGlobal(zeros(60), 0, RANGE_WINDOWS["1h"].bucketMin)).toHaveLength(30);
  });
});
