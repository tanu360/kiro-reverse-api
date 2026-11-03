import { queryOptions } from "@tanstack/react-query";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRemoteVersion } from "@/lib/api/system";
import { toast } from "@/lib/toast";
import { renderWithProviders } from "@/test/render";
import { SILENT_CHECK_DELAY_MS, UpdateCheckProvider } from "./update-check";
import { UpdateIndicator } from "./update-indicator";
import { UserMenu } from "./user-menu";

vi.mock("@/lib/api/system", () => ({
  versionQuery: () =>
    queryOptions({
      queryKey: ["version"],
      queryFn: () => Promise.resolve({ version: "v2.1.0" }),
      staleTime: Number.POSITIVE_INFINITY,
    }),
  fetchRemoteVersion: vi.fn(),
  compareVersions: (a: string, b: string) =>
    a.replace(/^v/, "").localeCompare(b.replace(/^v/, ""), undefined, { numeric: true }),
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));

const fetchRemote = vi.mocked(fetchRemoteVersion);

function renderHeader() {
  return renderWithProviders(
    <UpdateCheckProvider>
      <UpdateIndicator />
      <UserMenu variant="header" />
    </UpdateCheckProvider>,
  );
}

async function passSilentCheck(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SILENT_CHECK_DELAY_MS + 100);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchRemote.mockReset();
  vi.mocked(toast.dismiss).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UpdateIndicator", () => {
  it("renders nothing while no newer release is known", async () => {
    fetchRemote.mockResolvedValue({ version: "2.1.0" });
    renderHeader();
    await passSilentCheck();
    expect(screen.queryByRole("button", { name: /Update available/ })).not.toBeInTheDocument();
  });

  it("stays in the header after the toast and opens the update dialog", async () => {
    fetchRemote.mockResolvedValue({ version: "v2.2.0", changelog: "Fixes", download: "https://x" });
    const { user } = renderHeader();
    await passSilentCheck();

    const button = await screen.findByRole("button", { name: "Update available: 2.2.0" });
    await user.click(button);
    expect(await screen.findByText("Version update")).toBeInTheDocument();
    // The toast would cover the dialog footer (a bottom drawer on phones).
    expect(toast.dismiss).toHaveBeenCalledWith("update-available");
  });

  it("names the update in the Admin menu instead of Check for updates", async () => {
    fetchRemote.mockResolvedValue({ version: "v2.2.0", changelog: "", download: "https://x" });
    const { user } = renderHeader();
    await passSilentCheck();
    await screen.findByRole("button", { name: "Update available: 2.2.0" });

    await user.click(screen.getByRole("button", { name: "Admin menu" }));
    expect(
      await screen.findByRole("menuitem", { name: "Update available: 2.2.0" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Check for updates" })).not.toBeInTheDocument();
  });
});
