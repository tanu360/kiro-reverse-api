import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announce } from "@/lib/announce";
import { copyText } from "@/lib/clipboard";
import { renderWithProviders } from "@/test/render";
import { CopyButton } from "./copy-button";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("@/lib/announce", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/announce")>()),
  announce: vi.fn(),
}));

const copyTextMock = vi.mocked(copyText);

beforeEach(() => {
  copyTextMock.mockReset();
  vi.mocked(announce).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";

describe("CopyButton", () => {
  it("copies a plain value and shows the copied state", async () => {
    copyTextMock.mockResolvedValue(true);
    const { user } = renderWithProviders(<CopyButton label="Copy key" value="sk-123" />);
    const button = screen.getByRole("button", { name: "Copy key" });
    await user.click(button);
    expect(copyTextMock).toHaveBeenCalledTimes(1);
    expect(await copyTextMock.mock.calls[0]?.[0]).toBe("sk-123");
    await waitFor(() => expect(button).toHaveAttribute("data-copied"));
    // The tick and its tooltip show it, and a screen reader hears it.
    expect(announce).toHaveBeenCalledWith("Copied to the clipboard.");
  });

  it("does not read a copy out on Android, which shows its own copied overlay", async () => {
    copyTextMock.mockResolvedValue(true);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID_UA);
    const { user } = renderWithProviders(<CopyButton label="Copy key" value="sk-123" />);
    const button = screen.getByRole("button", { name: "Copy key" });
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("data-copied"));
    expect(announce).not.toHaveBeenCalled();
  });

  it("reads a copy out on an iPhone, where only the tick shows it", async () => {
    copyTextMock.mockResolvedValue(true);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    );
    // A phone-sized touch screen: every media query matches.
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }) as never,
    );
    const { user } = renderWithProviders(<CopyButton label="Copy key" value="sk-123" />);
    const button = screen.getByRole("button", { name: "Copy key" });
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("data-copied"));
    expect(announce).toHaveBeenCalledWith("Copied to the clipboard.");
  });

  it("still reads a failed copy out on Android", async () => {
    copyTextMock.mockResolvedValue(false);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID_UA);
    const { user } = renderWithProviders(<CopyButton label="Copy key" value="sk-123" />);
    await user.click(screen.getByRole("button", { name: "Copy key" }));
    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith("Could not copy to the clipboard.", {
        assertive: true,
      }),
    );
  });

  it("resolves a lazy value before it is copied", async () => {
    copyTextMock.mockResolvedValue(true);
    const { user } = renderWithProviders(
      <CopyButton label="Copy secret" value={() => Promise.resolve("secret-value")} />,
    );
    await user.click(screen.getByRole("button", { name: "Copy secret" }));
    expect(await copyTextMock.mock.calls[0]?.[0]).toBe("secret-value");
  });

  it("is an icon button sized by the Button, with no touch-size override", () => {
    renderWithProviders(<CopyButton label="Copy key" value="sk-123" />);
    const button = screen.getByRole("button", { name: "Copy key" });
    // The Button's icon size: 32 px on a phone, 36 px from sm up.
    expect(button).not.toHaveClass("size-10");
    expect(button).not.toHaveClass("md:size-8");
    expect(button).toHaveClass("size-8");
    expect(button).toHaveClass("sm:size-9");
  });

  it("passes a smaller icon size through", () => {
    renderWithProviders(<CopyButton label="Copy key" size="icon-sm" value="sk-123" />);
    // icon-sm: 28 px on a phone, 32 px from sm up.
    expect(screen.getByRole("button", { name: "Copy key" })).toHaveClass("size-7", "sm:size-8");
  });

  it("shows its label as a small outline button", async () => {
    copyTextMock.mockResolvedValue(true);
    const { user } = renderWithProviders(
      <CopyButton label="Copy link" showLabel value="https://x" />,
    );
    const button = screen.getByRole("button", { name: "Copy link" });
    expect(button).not.toHaveAttribute("aria-label");
    // The Button's sm: 28 px on a phone, 32 px from sm up.
    expect(button).toHaveClass("h-7", "sm:h-8");
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("data-copied"));
  });

  it("reports a failed copy on the button itself", async () => {
    copyTextMock.mockResolvedValue(false);
    const { user } = renderWithProviders(<CopyButton label="Copy key" value="sk-123" />);
    const button = screen.getByRole("button", { name: "Copy key" });
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("data-copy-failed"));
    expect(button).not.toHaveAttribute("data-copied");
    expect(announce).toHaveBeenCalledWith("Could not copy to the clipboard.", { assertive: true });
  });

  it("names a failed copy in its label", async () => {
    copyTextMock.mockResolvedValue(false);
    const { user } = renderWithProviders(
      <CopyButton label="Copy link" showLabel value="https://x" />,
    );
    const button = screen.getByRole("button", { name: "Copy link" });
    await user.click(button);
    await waitFor(() => expect(button).toHaveTextContent("Could not copy to the clipboard."));
  });
});
