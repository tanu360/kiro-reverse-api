import { describe, expect, it } from "vitest";
import { niceTicks } from "./y-axis";

describe("niceTicks", () => {
  it("ends on the nice domain top", () => {
    expect(niceTicks(35)).toEqual([0, 10, 20, 30, 40]);
    expect(niceTicks(35).at(-1)).toBe(40);
  });

  it("keeps the last tick on the domain top when nice() alone would stop short", () => {
    // [0, 66] nices to [0, 80] at a step of 20, so the top tick is 80, not 60.
    expect(niceTicks(60)).toEqual([0, 20, 40, 60, 80]);
    expect(niceTicks(1200, 4)).toEqual([0, 500, 1000, 1500]);
  });

  it("stays above the busiest value", () => {
    for (const max of [1, 3, 7, 9, 12, 48, 99, 101, 999, 4321]) {
      const ticks = niceTicks(max);
      expect(ticks[0]).toBe(0);
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(max);
    }
  });

  it("keeps whole-number steps for counts", () => {
    expect(niceTicks(2, 4, { integer: true })).toEqual([0, 1, 2, 3]);
    expect(niceTicks(1, 4, { integer: true })).toEqual([0, 1, 2]);
    expect(niceTicks(35, 4, { integer: true })).toEqual([0, 10, 20, 30, 40]);
  });

  it("gives a unit domain without data", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(Number.NaN)).toEqual([0, 1]);
  });
});
