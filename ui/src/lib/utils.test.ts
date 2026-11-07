import { describe, expect, it } from "vitest";
import { cn, keyByText, placeholderKeys } from "./utils";

describe("cn", () => {
  it("lets the later Tailwind class win a conflict", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("drops falsy inputs", () => {
    const enabled = false;
    expect(cn("a", enabled && "b")).toBe("a");
  });

  it("keeps a custom text size next to a text colour", () => {
    expect(cn("font-semibold text-display leading-none", "text-destructive-foreground")).toBe(
      "font-semibold text-display leading-none text-destructive-foreground",
    );
    expect(cn("text-muted-foreground", "font-normal text-meta")).toBe(
      "text-muted-foreground font-normal text-meta",
    );
    expect(cn("text-heading", "text-foreground")).toBe("text-heading text-foreground");
  });

  it("lets a later custom text size replace an earlier one", () => {
    expect(cn("text-sm", "text-kpi")).toBe("text-kpi");
    expect(cn("text-lg", "text-subtitle")).toBe("text-subtitle");
    expect(cn("text-2xs", "text-meta")).toBe("text-meta");
  });
});

describe("keyByText", () => {
  it("keys each item by its text, numbering repeats", () => {
    expect(keyByText(["a", "b", "a", "a"], (text) => text).map(({ key }) => key)).toEqual([
      "0:a",
      "0:b",
      "1:a",
      "2:a",
    ]);
  });

  it("keeps keys unique when a text looks like a numbered key", () => {
    const keys = keyByText(["1:a", "a", "a"], (text) => text).map(({ key }) => key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the items in order", () => {
    const lines = [{ text: "x" }, { text: "y" }];
    expect(keyByText(lines, (line) => line.text).map(({ item }) => item)).toEqual(lines);
  });
});

describe("placeholderKeys", () => {
  it("names each placeholder from 1", () => {
    expect(placeholderKeys("row", 3)).toEqual(["row-1", "row-2", "row-3"]);
    expect(placeholderKeys("row", 0)).toEqual([]);
  });
});
