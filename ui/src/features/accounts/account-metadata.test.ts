import { describe, expect, it } from "vitest";
import {
  hasTag,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  normalizeTag,
  normalizeTags,
  parseTagInput,
} from "./account-metadata";

describe("normalizeTag / normalizeTags", () => {
  it("cleans, collapses and cuts a tag as the server does", () => {
    expect(normalizeTag("  team \n  a\u0000 ")).toBe("team a");
    expect(normalizeTag("é".repeat(MAX_TAG_LENGTH + 3))).toBe("é".repeat(MAX_TAG_LENGTH));
    // Code points, not UTF-16 units: an emoji never splits.
    expect([...normalizeTag("🙂".repeat(MAX_TAG_LENGTH + 1))]).toHaveLength(MAX_TAG_LENGTH);
  });

  it("drops empty tags and duplicates in any case, keeping the first spelling and MAX_TAGS", () => {
    expect(normalizeTags(["Team-A", " team-a ", "", "backup"])).toEqual(["Team-A", "backup"]);
    const many = Array.from({ length: MAX_TAGS + 2 }, (_, i) => `t${i}`);
    expect(normalizeTags(many)).toEqual(many.slice(0, MAX_TAGS));
  });
});

describe("parseTagInput", () => {
  it("splits on commas, including the CJK ones, and dedupes", () => {
    expect(parseTagInput("team-a, backup，Team-A、 ci ,, ")).toEqual({
      tags: ["team-a", "backup", "ci"],
    });
    expect(parseTagInput("   ")).toEqual({ tags: [] });
  });

  it("refuses a tag that is too long instead of cutting it", () => {
    const long = "x".repeat(MAX_TAG_LENGTH + 1);
    expect(parseTagInput(`ok, ${long}`).error).toEqual({ kind: "tooLong", tag: long });
    expect(parseTagInput("x".repeat(MAX_TAG_LENGTH)).error).toBeUndefined();
  });

  it("refuses more than MAX_TAGS distinct tags", () => {
    const tags = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`);
    expect(parseTagInput(tags.join(",")).error).toEqual({ kind: "tooMany" });
    expect(parseTagInput([...tags.slice(0, MAX_TAGS), "T0"].join(",")).error).toBeUndefined();
  });
});

describe("hasTag", () => {
  it("matches ignoring case", () => {
    expect(hasTag({ tags: ["Team-A"] }, "team-a")).toBe(true);
    expect(hasTag({ tags: ["Team-A"] }, "team")).toBe(false);
    expect(hasTag({ tags: [] }, "x")).toBe(false);
  });
});
