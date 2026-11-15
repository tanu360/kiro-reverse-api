import { describe, expect, it } from "vitest";
import { normalizeUpdateStatus, updateMoving } from "./update";

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
