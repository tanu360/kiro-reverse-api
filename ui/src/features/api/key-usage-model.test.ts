import { describe, expect, it } from "vitest";
import type {
  ApiKeyUsageEntry,
  ApiKeyUsageKind,
  ApiKeyUsageResponse,
  ApiKeyUsageTotals,
} from "@/lib/api/api-key-usage";
import { EMPTY_TOTALS, entryRef, findEntry, seriesBars } from "./key-usage-model";

function totals(partial: Partial<ApiKeyUsageTotals>): ApiKeyUsageTotals {
  const merged = { ...EMPTY_TOTALS, ...partial };
  return { ...merged, tokens: merged.inTokens + merged.outTokens };
}

function entry(
  id: string,
  kind: ApiKeyUsageKind,
  partial: Partial<ApiKeyUsageTotals>,
  series: ApiKeyUsageTotals[] = [],
): ApiKeyUsageEntry {
  return { id, kind, totals: totals(partial), series };
}

describe("entryRef", () => {
  it("prefixes keys and deleted keys with their kind and names the groups", () => {
    expect(entryRef({ id: "a", kind: "key" })).toBe("key:a");
    expect(entryRef({ id: "a", kind: "deleted" })).toBe("deleted:a");
    expect(entryRef({ id: "none", kind: "none" })).toBe("none");
    expect(entryRef({ id: "invalid", kind: "invalid" })).toBe("invalid");
  });
});

describe("seriesBars", () => {
  const data: ApiKeyUsageResponse = {
    range: "24h",
    bucket: "hour",
    bucketSeconds: 3600,
    tzOffset: 0,
    from: 0,
    to: 7200,
    nowUnix: 7000,
    buckets: [0, 3600],
    totals: EMPTY_TOTALS,
    keys: [
      entry("a", "key", { requests: 4 }, [
        totals({ requests: 3, succeeded: 2, failed: 1, inTokens: 10, outTokens: 4, credits: 0.5 }),
        totals({ requests: 1, succeeded: 1, inTokens: 7, outTokens: 1, credits: 0.25 }),
      ]),
    ],
  };
  const a = findEntry(data, "key:a");

  it("splits requests into succeeded and failed", () => {
    expect(seriesBars(data, a, "requests")).toEqual([
      { start: 0, primary: 2, secondary: 1 },
      { start: 3600, primary: 1, secondary: 0 },
    ]);
  });

  it("splits tokens into input and output", () => {
    expect(seriesBars(data, a, "tokens")).toEqual([
      { start: 0, primary: 10, secondary: 4 },
      { start: 3600, primary: 7, secondary: 1 },
    ]);
  });

  it("charts credits as one part", () => {
    expect(seriesBars(data, a, "credits").map((bar) => bar.primary)).toEqual([0.5, 0.25]);
  });

  it("gives a key without traffic a zero bar per bucket", () => {
    expect(findEntry(data, "key:missing")).toBeUndefined();
    expect(seriesBars(data, undefined, "requests")).toEqual([
      { start: 0, primary: 0, secondary: 0 },
      { start: 3600, primary: 0, secondary: 0 },
    ]);
  });
});
