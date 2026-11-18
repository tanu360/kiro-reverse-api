import { describe, expect, it } from "vitest";
import type { AddedAccountRef } from "@/lib/api/types";
import type { TFunction } from "@/lib/i18n";
import { batchResultText, savedText } from "./result-text";

// Keys and counts only, so each assertion names the message it expects. Joined sentences and
// lists read as the English templates join them.
const t: TFunction = (key, params) =>
  key === "common:text.joinSentences"
    ? `${params?.first} ${params?.second}`
    : key === "common:text.joinList"
      ? `${params?.first}; ${params?.second}`
      : params?.count !== undefined
        ? `${key}(${params.count})`
        : params?.name
          ? `${key}:${params.name}`
          : key;

const ref = (id: string, updated?: boolean): AddedAccountRef => ({ id, email: "", updated });

describe("result text", () => {
  it("says whether one login added or updated an account", () => {
    expect(savedText(t, ref("a", true), "dev")).toBe("updatedExisting:dev");
    expect(savedText(t, ref("a"), "dev")).toBe("success:dev");
  });

  it("reports updated accounts", () => {
    expect(batchResultText(t, [ref("a", true), ref("b", true)], [])).toBe("importUpdated(2)");
  });

  it("mixes added and updated", () => {
    expect(batchResultText(t, [ref("a", true), ref("b"), ref("c", false)], [])).toBe(
      "importSuccess(2) importUpdated(1)",
    );
    expect(batchResultText(t, [ref("a", true), ref("b")], ["broken"])).toBe(
      "importPartial(1) importUpdated(1) broken",
    );
  });

  it("gives only the reasons when nothing was added, the first three and a count", () => {
    expect(batchResultText(t, [], ["one", "two", "three", "four", "five"])).toBe(
      "one; two; three; moreFailures(2)",
    );
  });
});
