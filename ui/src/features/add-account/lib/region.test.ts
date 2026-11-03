import { describe, expect, it } from "vitest";
import { DEFAULT_REGION, parseRegion } from "./region";

describe("parseRegion", () => {
  it("treats an empty value as us-east-1", () => {
    expect(parseRegion("")).toEqual({ ok: true, region: DEFAULT_REGION });
    expect(parseRegion("   ")).toEqual({ ok: true, region: "us-east-1" });
  });

  it("trims and lowercases a valid region", () => {
    expect(parseRegion("  EU-Central-1 ")).toEqual({ ok: true, region: "eu-central-1" });
    expect(parseRegion("us-gov-west-1")).toEqual({ ok: true, region: "us-gov-west-1" });
  });

  it("rejects text that is not a region", () => {
    expect(parseRegion("useast1")).toEqual({ ok: false });
    expect(parseRegion("us-east")).toEqual({ ok: false });
    expect(parseRegion("us east 1")).toEqual({ ok: false });
  });
});
