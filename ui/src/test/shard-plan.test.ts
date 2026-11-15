import { planShards } from "./shard-plan";

const files = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts", "f.test.ts"];

describe("planShards", () => {
  it("puts every file in exactly one shard", () => {
    for (let count = 1; count <= 8; count++) {
      const plan = planShards(files, { "a.test.ts": 900, "c.test.ts": 40 }, count);
      expect(plan).toHaveLength(count);
      expect(plan.flat().sort()).toEqual(files);
    }
  });

  it("evens out the recorded time, longest file first", () => {
    const timings = {
      "a.test.ts": 30,
      "b.test.ts": 20,
      "c.test.ts": 20,
      "d.test.ts": 10,
      "e.test.ts": 10,
      "f.test.ts": 10,
    };
    expect(planShards(files, timings, 2)).toEqual([
      ["a.test.ts", "d.test.ts", "e.test.ts"],
      ["b.test.ts", "c.test.ts", "f.test.ts"],
    ]);
  });

  it("gives the same plan whatever order the files come in", () => {
    const timings = { "b.test.ts": 5, "e.test.ts": 50 };
    const plan = planShards(files, timings, 3);
    expect(planShards([...files].reverse(), timings, 3)).toEqual(plan);
  });

  it("weighs a file without a recorded time as the average", () => {
    // a and b average 20, so the new file c weighs 20 and joins the lighter shard.
    expect(
      planShards(["a.test.ts", "b.test.ts", "c.test.ts"], { "a.test.ts": 30, "b.test.ts": 10 }, 2),
    ).toEqual([["a.test.ts"], ["c.test.ts", "b.test.ts"]]);
  });

  it("refuses a shard count below one", () => {
    expect(() => planShards(files, {}, 0)).toThrow(RangeError);
  });
});
