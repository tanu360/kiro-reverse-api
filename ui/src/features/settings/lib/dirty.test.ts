import { describe, expect, it } from "vitest";
import { initialDraftState, isEqual, receiveServer } from "./dirty";

describe("isEqual", () => {
  it("compares nested JSON values and ignores undefined fields", () => {
    expect(isEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(true);
    expect(isEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(isEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(isEqual([1], { 0: 1 })).toBe(false);
    expect(isEqual(null, {})).toBe(false);
  });
});

describe("receiveServer", () => {
  const equal = (a: number, b: number) => a === b;

  it("lets a clean draft take the new server copy", () => {
    expect(receiveServer(initialDraftState(1), 2, equal)).toEqual(initialDraftState(2));
  });

  it("keeps a dirty draft and flags the server change", () => {
    const dirty = { base: 1, draft: 5, seen: 1, serverChanged: false };
    expect(receiveServer(dirty, 2, equal)).toEqual({
      base: 1,
      draft: 5,
      seen: 2,
      serverChanged: true,
    });
  });

  it("returns the same state when the server copy did not change", () => {
    const state = { base: 1, draft: 5, seen: 1, serverChanged: false };
    expect(receiveServer(state, 1, equal)).toBe(state);
  });

  it("lets a saved draft take the server copy that follows the save", () => {
    // After commit(7): base and draft are 7, seen is still the old copy.
    const saved = { base: 7, draft: 7, seen: 1, serverChanged: false };
    expect(receiveServer(saved, 7, equal)).toEqual(initialDraftState(7));
  });
});
