import { describe, expect, it } from "vitest";
import type { AccountHeatmap, HeatmapCell, HeatmapData, ModelMixEntry } from "@/lib/api/types";
import {
  bucketGlobal,
  cellOpacity,
  hourDelta,
  modelSlices,
  sparklineBuckets,
  topAccounts,
  windowCells,
} from "./aggregate";

/** Newest-first cells: `values[i]` is offset i. */
function cells(values: Array<[reqs: number, failures: number]>): HeatmapCell[] {
  return values.map(([reqs, failures], offset) => ({ offset, reqs, failures }));
}

function zeros(count: number): HeatmapCell[] {
  return Array.from({ length: count }, (_, offset) => ({ offset, reqs: 0, failures: 0 }));
}

function account(accountId: string, values: Array<[number, number]>): AccountHeatmap {
  return { accountId, email: `${accountId}@example.com`, cells: cells(values) };
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

describe("sparklineBuckets", () => {
  it("sums the current hour into 12 oldest-first 5-minute buckets", () => {
    const input = zeros(120);
    input[0].reqs = 2;
    input[4].reqs = 3;
    input[55].reqs = 7;
    input[90].reqs = 100; // previous hour, ignored
    const buckets = sparklineBuckets(input, (cell) => cell.reqs);
    expect(buckets).toHaveLength(12);
    expect(buckets[0]).toEqual({ value: 7 });
    expect(buckets[11]).toEqual({ value: 5 });
    expect(buckets.reduce((sum, b) => sum + b.value, 0)).toBe(12);
  });
});

describe("topAccounts", () => {
  const heatmap: HeatmapData = {
    windowMin: 3,
    nowUnix: 0,
    global: { accountId: "_global_", cells: zeros(3) },
    accounts: [
      account("a", [
        [1, 0],
        [0, 0],
        [0, 0],
      ]),
      account("b", [
        [2, 2],
        [1, 0],
        [0, 0],
      ]),
      account("c", [
        [0, 0],
        [3, 0],
        [0, 0],
      ]),
      account("d", [
        [0, 0],
        [0, 0],
        [0, 0],
      ]),
    ],
  };

  it("orders by reqs + failures and returns the rest count", () => {
    const { rows, rest } = topAccounts(heatmap, 2);
    expect(rows.map((row) => row.accountId)).toEqual(["b", "c"]);
    // "a" has traffic but did not fit; "d" has none and is not counted.
    expect(rest).toBe(1);
  });

  it("only scores cells inside the window", () => {
    const { rows } = topAccounts(heatmap, 1, 1);
    expect(rows.map((row) => row.accountId)).toEqual(["b"]);
    const { rows: firstMinute, rest } = topAccounts(heatmap, 5, 1);
    expect(firstMinute.map((row) => row.accountId)).toEqual(["b", "a"]);
    expect(rest).toBe(0);
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

describe("cellOpacity", () => {
  it("maps 0 to 0.18 and the maximum to 1", () => {
    expect(cellOpacity(0, 10)).toBe(0.18);
    expect(cellOpacity(10, 10)).toBe(1);
    expect(cellOpacity(5, 10)).toBeCloseTo(0.59);
  });

  it("treats a maximum below 1 as 1 and caps at 1", () => {
    expect(cellOpacity(1, 0)).toBe(1);
    expect(cellOpacity(20, 10)).toBe(1);
  });
});

describe("windowCells", () => {
  it("returns the first windowMin offsets oldest-first and fills gaps", () => {
    const input: HeatmapCell[] = [
      { offset: 0, reqs: 1, failures: 0 },
      { offset: 2, reqs: 3, failures: 1 },
      { offset: 5, reqs: 9, failures: 0 },
    ];
    expect(windowCells(input, 3)).toEqual([
      { offset: 2, reqs: 3, failures: 1 },
      { offset: 1, reqs: 0, failures: 0 },
      { offset: 0, reqs: 1, failures: 0 },
    ]);
  });
});
