import { describe, expect, it } from "vitest";
import type { PromptFilterConfig } from "@/lib/api/types";
import { newRule, regexFails, samePromptFilter } from "./prompt-filter";

describe("newRule", () => {
  it("builds an enabled, empty rule with a time-based id", () => {
    expect(newRule("regex", [], 1700000000000)).toEqual({
      id: "rule-1700000000000",
      name: "",
      type: "regex",
      match: "",
      replace: "",
      enabled: true,
    });
  });

  it("does not repeat an id within one millisecond", () => {
    const first = newRule("lines-containing", [], 5);
    expect(newRule("regex", [first], 5).id).toBe("rule-6");
  });
});

describe("regexFails", () => {
  it("flags patterns Go cannot compile, not JavaScript", () => {
    expect(regexFails("(")).toBe(true);
    expect(regexFails("\\bsecret\\b")).toBe(false);
    expect(regexFails("")).toBe(false);
    // Go accepts inline flags and rejects lookarounds and backreferences; JavaScript the reverse.
    expect(regexFails("(?i)secret")).toBe(false);
    expect(regexFails("(?=secret)")).toBe(true);
    expect(regexFails("(a)\\1")).toBe(true);
  });
});

describe("samePromptFilter", () => {
  const base: PromptFilterConfig = {
    filterClaudeCode: false,
    filterEnvNoise: true,
    filterStripBoundaries: false,
    rules: [{ id: "rule-1", name: "", type: "lines-containing", match: "x", enabled: true }],
  };

  it("treats a missing replace like an empty one", () => {
    expect(samePromptFilter(base, { ...base, rules: [{ ...base.rules[0], replace: "" }] })).toBe(
      true,
    );
  });

  it("sees a changed switch or rule", () => {
    expect(samePromptFilter(base, { ...base, filterEnvNoise: false })).toBe(false);
    expect(samePromptFilter(base, { ...base, rules: [{ ...base.rules[0], enabled: false }] })).toBe(
      false,
    );
  });
});
