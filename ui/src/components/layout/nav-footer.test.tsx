import { queryOptions } from "@tanstack/react-query";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { fetchRemoteVersion } from "@/lib/api/system";
import { toast } from "@/lib/toast";
import { renderWithProviders } from "@/test/render";
import { NavFooter } from "./nav-footer";
import { SILENT_CHECK_DELAY_MS, UpdateCheckProvider } from "./update-check";

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

function renderFooter() {
  return renderWithProviders(
    <UpdateCheckProvider>
      <SidebarProvider>
        <NavFooter />
      </SidebarProvider>
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

describe("NavFooter update card", () => {
  it("shows no card or bell while the running version is the latest", async () => {
    fetchRemote.mockResolvedValue({ version: "2.1.0" });
    renderFooter();
    await passSilentCheck();
    expect(screen.queryByText("New version")).toBeNull();
    expect(screen.queryByRole("button", { name: /Update available/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Admin menu" })).toBeInTheDocument();
  });

  it("names the release with its first changelog line and opens the update dialog", async () => {
    fetchRemote.mockResolvedValue({
      version: "v2.2.0",
      changelog: "🎨 New: a brand-new admin panel\n🛠️ Fixed: restores",
      download: "https://x",
    });
    const { user } = renderFooter();
    await passSilentCheck();

    expect(await screen.findByText("Kiro Proxy 2.2.0")).toBeInTheDocument();
    expect(screen.getByText("a brand-new admin panel")).toBeInTheDocument();
    // The icon rail's bell, hidden by CSS while expanded, opens the same dialog.
    expect(screen.getByRole("button", { name: "Update available: 2.2.0" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "See what's new" }));
    expect(await screen.findByText("Version update")).toBeInTheDocument();
    // The toast would cover the dialog footer (a bottom drawer on phones).
    expect(toast.dismiss).toHaveBeenCalledWith("update-available");
  });
});
