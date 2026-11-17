import { afterEach, describe, expect, it, vi } from "vitest";
import { copiedToastWanted } from "./copy-toast";

describe("copiedToastWanted", () => {
  const phone = (matches: boolean) =>
    vi
      .spyOn(window, "matchMedia")
      .mockImplementation(
        (query: string) =>
          ({ matches, media: query, addEventListener() {}, removeEventListener() {} }) as never,
      );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never toasts on Android, which shows its own copied overlay", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36",
    );
    phone(false);
    expect(copiedToastWanted({ marksItself: false })).toBe(false);
    expect(copiedToastWanted({ marksItself: true })).toBe(false);
  });

  it("skips the toast on another phone only when the control marks the copy itself", () => {
    phone(true);
    expect(copiedToastWanted({ marksItself: true })).toBe(false);
    expect(copiedToastWanted({ marksItself: false })).toBe(true);
  });

  it("toasts on a desktop", () => {
    phone(false);
    expect(copiedToastWanted({ marksItself: true })).toBe(true);
  });
});
