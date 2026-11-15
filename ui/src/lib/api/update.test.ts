import { describe, expect, it } from "vitest";
import { type TFunction, translate } from "@/lib/i18n";
import { normalizeUpdateStatus, updateErrorText, updateMoving } from "./update";

describe("normalizeUpdateStatus", () => {
  it("keeps the fields of a download under way", () => {
    expect(
      normalizeUpdateStatus({
        state: "downloading",
        supported: true,
        version: "3.6.0",
        progress: 45.6,
        downloaded: 4_194_304,
        total: 9_437_184,
      }),
    ).toEqual({
      state: "downloading",
      supported: true,
      reason: undefined,
      path: undefined,
      version: "3.6.0",
      progress: 46,
      downloaded: 4_194_304,
      total: 9_437_184,
      error: undefined,
    });
  });

  it("reads an unknown state as an error and an unknown reason as none", () => {
    const status = normalizeUpdateStatus({ state: "exploded", supported: "yes", reason: "moon" });
    expect(status.state).toBe("error");
    expect(status.supported).toBe(false);
    expect(status.reason).toBeUndefined();
  });

  it("clamps the progress and drops sizes that are not positive", () => {
    const status = normalizeUpdateStatus({ state: "downloading", progress: 140, total: 0 });
    expect(status.progress).toBe(100);
    expect(status.total).toBeUndefined();
  });
});

describe("updateMoving", () => {
  it("is true only while the download or the restart moves on its own", () => {
    expect(updateMoving({ state: "downloading", supported: true })).toBe(true);
    expect(updateMoving({ state: "restarting", supported: true })).toBe(true);
    expect(updateMoving({ state: "ready", supported: true })).toBe(false);
    expect(updateMoving(undefined)).toBe(false);
  });
});

describe("updateErrorText", () => {
  const ja: TFunction = (key, params) => translate("ja", "common", key, params);
  const en: TFunction = (key, params) => translate("en", "common", key, params);

  it("words a known code in the UI language, with the version and the detail", () => {
    expect(
      updateErrorText(
        {
          version: "3.6.0",
          error: "Version 3.6.0's release is not on GitHub yet.",
          errorCode: "not_published",
        },
        ja,
      ),
    ).toBe(
      "バージョン 3.6.0 のリリースはまだ GitHub にありません。公開中の可能性があるため、数分後に再試行してください。",
    );
    expect(
      updateErrorText(
        {
          error: "GitHub answered 502 Bad Gateway to the update download.",
          errorCode: "download_failed",
          errorDetail: "HTTP 502 Bad Gateway",
        },
        en,
      ),
    ).toBe("Could not download the update. (Details: HTTP 502 Bad Gateway)");
  });

  it("puts the old program's path inside the rollback text", () => {
    expect(
      updateErrorText(
        { errorCode: "rollback_failed", errorDetail: "/opt/kiro/kiro-proxy.old" },
        en,
      ),
    ).toBe(
      "Could not put the new program in place, nor the old one back. The old program is at /opt/kiro/kiro-proxy.old.",
    );
  });

  it("falls back to the server's English for an unknown code or none", () => {
    expect(updateErrorText({ error: "Something new.", errorCode: "later_code" }, ja)).toBe(
      "Something new.",
    );
    expect(updateErrorText({ error: "Old server." }, ja)).toBe("Old server.");
    expect(updateErrorText({}, ja)).toBeUndefined();
  });
});
