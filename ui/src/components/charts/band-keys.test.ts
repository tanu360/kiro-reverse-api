import { scaleBand } from "d3-scale";
import { describe, expect, it } from "vitest";
import { bandKeys } from "./band-keys";

describe("bandKeys", () => {
  it("keys each bar on its label when labels are distinct", () => {
    expect(bandKeys(["00:00", "01:00", "02:00"])).toEqual(["00:00", "01:00", "02:00"]);
  });

  it("gives a repeated label its own band, so no two bars overlap", () => {
    // The fall-back night: 01:00 comes round twice.
    const labels = ["00:00", "01:00", "01:00", "02:00"];
    const keys = bandKeys(labels);
    expect(new Set(keys).size).toBe(labels.length);
    const scale = scaleBand<string>().domain(keys).range([0, 400]);
    const xs = keys.map((key) => scale(key));
    expect(new Set(xs).size).toBe(labels.length);
    expect(xs).toEqual([...xs].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });
});
