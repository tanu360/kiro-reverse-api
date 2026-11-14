import { describe, expect, it } from "vitest";
import {
  digitsOnly,
  headerNameChars,
  hexChars,
  noSpaces,
  recoveryCodeChars,
  regionChars,
} from "./input-filters";

describe("input filters", () => {
  it("keeps only what each value can hold", () => {
    expect(digitsOnly("1a2 3-4")).toBe("1234");
    expect(digitsOnly("123 4567", 6)).toBe("123456");
    expect(noSpaces(" claude sonnet\t4 ")).toBe("claudesonnet4");
    expect(regionChars(" EU-West_1! ")).toBe("eu-west1");
    expect(hexChars("6F1d-zz9x")).toBe("6F1d-9");
    expect(headerNameChars("X Trace:Id/é")).toBe("XTraceId");
    expect(recoveryCodeChars(" k7xq2 m9fd4.")).toBe("k7xq2m9fd4");
  });
});
