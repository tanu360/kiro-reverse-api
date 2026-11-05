import { describe, expect, it } from "vitest";
import { roundTimeTicks } from "./x-axis";

const at = (h: number, m: number, s = 0) => new Date(2026, 10, 5, h, m, s);
const hm = (dates: Date[]) =>
  dates.map(
    (d) =>
      `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  );

describe("roundTimeTicks", () => {
  it("lands on local quarter hours inside the range", () => {
    expect(hm(roundTimeTicks(at(13, 52), at(14, 52), 15))).toEqual([
      "14:00",
      "14:15",
      "14:30",
      "14:45",
    ]);
  });

  it("keeps a start that is already round and an end on a boundary", () => {
    expect(hm(roundTimeTicks(at(12, 0), at(15, 0), 60))).toEqual([
      "12:00",
      "13:00",
      "14:00",
      "15:00",
    ]);
  });

  it("skips a boundary that the start has passed by seconds", () => {
    expect(hm(roundTimeTicks(at(12, 0, 30), at(13, 0), 60))).toEqual(["13:00"]);
  });

  it("counts four-hour steps from midnight", () => {
    expect(hm(roundTimeTicks(at(1, 10), at(13, 0), 240))).toEqual([
      "04:00",
      "08:00",
      "12:00",
    ]);
  });

  it("returns nothing for an empty or invalid range", () => {
    expect(roundTimeTicks(at(14, 1), at(14, 14), 15)).toEqual([]);
    expect(roundTimeTicks(new Date(Number.NaN), at(14, 0), 15)).toEqual([]);
  });
});
