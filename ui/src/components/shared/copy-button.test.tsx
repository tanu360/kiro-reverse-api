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

  it("reports a failed copy", async () => {
    copyTextMock.mockResolvedValue(false);
    const { user } = renderWithProviders(<CopyButton label="Copy key" value="sk-123" />);
    const button = screen.getByRole("button", { name: "Copy key" });
    await user.click(button);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(button).not.toHaveAttribute("data-copied");
  });
});
