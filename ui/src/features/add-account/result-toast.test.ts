import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddedAccountRef } from "@/lib/api/types";
import type { TFunction } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { savedTitle, showBatchResult } from "./result-toast";

// Keys and counts only, so each assertion names the message it expects.
const t: TFunction = (key, params) =>
  params?.count !== undefined
    ? `${key}(${params.count})`
    : params?.name
      ? `${key}:${params.name}`
      : key;

const ref = (id: string, updated?: boolean): AddedAccountRef => ({ id, email: "", updated });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("result toasts", () => {
  it("reports updated accounts", () => {
    const success = vi.spyOn(toast, "success").mockReturnValue("toast");
    showBatchResult(t, [ref("a", true), ref("b", true)], []);
    expect(success).toHaveBeenCalledWith(
      "importUpdated(2)",
      expect.objectContaining({ description: undefined }),
    );
    expect(savedTitle(t, ref("a", true), "dev")).toBe("updatedExisting:dev");
    expect(savedTitle(t, ref("a"), "dev")).toBe("success:dev");
  });

  it("mixes added and updated", () => {
    const success = vi.spyOn(toast, "success").mockReturnValue("toast");
    const warning = vi.spyOn(toast, "warning").mockReturnValue("toast");
    showBatchResult(t, [ref("a", true), ref("b"), ref("c", false)], []);
    expect(success).toHaveBeenCalledWith(
      "importSuccess(2)",
      expect.objectContaining({ description: "importUpdated(1)" }),
    );

    showBatchResult(t, [ref("a", true), ref("b")], ["broken"]);
    expect(warning).toHaveBeenCalledWith(
      "importPartial(1)",
      expect.objectContaining({ description: "importUpdated(1) broken" }),
    );
  });
});
