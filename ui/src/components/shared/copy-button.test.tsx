import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { renderWithProviders } from "@/test/render";
import { CopyButton } from "./copy-button";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const copyTextMock = vi.mocked(copyText);

beforeEach(() => {
  copyTextMock.mockReset();
});

describe("CopyButton", () => {
  it("copies a plain value and shows the copied state", async () => {
    copyTextMock.mockResolvedValue(true);
    const { user } = renderWithProviders(<CopyButton label="Copy key" value="sk-123" />);
    const button = screen.getByRole("button", { name: "Copy key" });
    await user.click(button);
    expect(copyTextMock).toHaveBeenCalledTimes(1);
    expect(await copyTextMock.mock.calls[0]?.[0]).toBe("sk-123");
    await waitFor(() => expect(button).toHaveAttribute("data-copied"));
    expect(toast.success).toHaveBeenCalled();
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
    expect(button).not.toHaveClass("size-10");
    expect(button).not.toHaveClass("md:size-8");
    expect(button).toHaveClass("size-9");
    expect(button).not.toHaveClass("sm:size-8");
  });

  it("passes a smaller icon size through", () => {
    renderWithProviders(<CopyButton label="Copy key" size="icon-sm" value="sk-123" />);
    expect(screen.getByRole("button", { name: "Copy key" })).toHaveClass("size-8");
  });

  it("shows its label as a small outline button", async () => {
    copyTextMock.mockResolvedValue(true);
    const { user } = renderWithProviders(
      <CopyButton label="Copy link" showLabel value="https://x" />,
    );
    const button = screen.getByRole("button", { name: "Copy link" });
    expect(button).not.toHaveAttribute("aria-label");
    expect(button).toHaveClass("h-8");
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("data-copied"));
  });

  it("reports a failed copy", async () => {
    copyTextMock.mockResolvedValue(false);
    const { user } = renderWithProviders(<CopyButton label="Copy key" value="sk-123" />);
    const button = screen.getByRole("button", { name: "Copy key" });
    await user.click(button);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(button).not.toHaveAttribute("data-copied");
  });
});
