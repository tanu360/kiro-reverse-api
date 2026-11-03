import { describe, expect, it } from "vitest";
import {
  localRowForServerIndex,
  type MappingRow,
  moveRow,
  prepareMappings,
  rowsFromRules,
  sameMappings,
} from "./model-mappings";

const row = (id: string, key: string, value: string): MappingRow => ({ id, key, value });

describe("prepareMappings", () => {
  it("trims, drops both-blank rows, keeps half-filled rows and maps sent rows back", () => {
    const rows = [
      row("a", "  gpt-5 ", " claude-opus-5 "),
      row("b", "   ", ""),
      row("c", "gpt-4", ""),
      row("d", "", ""),
      row("e", "", " claude-haiku-4.5"),
    ];
    expect(prepareMappings(rows)).toEqual({
      mappings: [
        { key: "gpt-5", value: "claude-opus-5" },
        { key: "gpt-4", value: "" },
        { key: "", value: "claude-haiku-4.5" },
      ],
      rowIndexes: [0, 2, 4],
    });
  });

  it("gives an empty list for no rows", () => {
    expect(prepareMappings([])).toEqual({ mappings: [], rowIndexes: [] });
  });
});

describe("localRowForServerIndex", () => {
  const rowIndexes = [0, 2, 4];

  it("maps a server index to the local row", () => {
    expect(localRowForServerIndex(rowIndexes, 0)).toBe(0);
    expect(localRowForServerIndex(rowIndexes, 1)).toBe(2);
    expect(localRowForServerIndex(rowIndexes, 2)).toBe(4);
  });

  it("gives null for -1, a missing index or one out of range", () => {
    expect(localRowForServerIndex(rowIndexes, -1)).toBeNull();
    expect(localRowForServerIndex(rowIndexes, null)).toBeNull();
    expect(localRowForServerIndex(rowIndexes, undefined)).toBeNull();
    expect(localRowForServerIndex(rowIndexes, 3)).toBeNull();
  });
});

describe("moveRow", () => {
  const rows = ["a", "b", "c"];

  it("moves a row up and down", () => {
    expect(moveRow(rows, 1, 0)).toEqual(["b", "a", "c"]);
    expect(moveRow(rows, 1, 2)).toEqual(["a", "c", "b"]);
    expect(moveRow(rows, 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("keeps the order at the bounds", () => {
    expect(moveRow(rows, 0, -1)).toBe(rows);
    expect(moveRow(rows, 2, 3)).toBe(rows);
    expect(moveRow(rows, 1, 1)).toBe(rows);
  });

  it("does not change the input", () => {
    moveRow(rows, 0, 1);
    expect(rows).toEqual(["a", "b", "c"]);
  });
});

describe("rowsFromRules and sameMappings", () => {
  it("gives every rule a distinct id and compares by content only", () => {
    const rules = [
      { key: "a", value: "b" },
      { key: "c", value: "d" },
    ];
    const first = rowsFromRules(rules);
    const second = rowsFromRules(rules);
    expect(new Set(first.map((r) => r.id)).size).toBe(2);
    expect(first[0].id).not.toBe(second[0].id);
    expect(sameMappings(first, second)).toBe(true);
    expect(sameMappings(first, [...second].reverse())).toBe(false);
    expect(sameMappings(first, second.slice(1))).toBe(false);
  });
});
