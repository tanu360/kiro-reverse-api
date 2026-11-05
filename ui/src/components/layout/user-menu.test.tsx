import { queryOptions } from "@tanstack/react-query";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { fetchRemoteVersion } from "@/lib/api/system";
import { toast } from "@/lib/toast";
import { renderWithProviders } from "@/test/render";
import { SILENT_CHECK_DELAY_MS, UpdateCheckProvider } from "./update-check";
import { UserMenu } from "./user-menu";

vi.mock("@/lib/api/system", () => {
  const parts = (v: string) =>
    v
      .replace(/^v/i, "")
      .split(".")
      .map((n) => Number(n) || 0);
  return {
    versionQuery: () =>
      queryOptions({
        queryKey: ["version"],
        queryFn: () => Promise.resolve({ version: "v2.1.0" }),
        staleTime: Number.POSITIVE_INFINITY,
      }),
    fetchRemoteVersion: vi.fn(),
    compareVersions: (a: string, b: string) => {
      const [x, y] = [parts(a), parts(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d !== 0) return d > 0 ? 1 : -1;
      }
      return 0;
    },
  };
});
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));

const fetchRemote = vi.mocked(fetchRemoteVersion);

function renderMenu() {
  return renderWithProviders(
    <UpdateCheckProvider>
      <SidebarProvider>
        <UserMenu />
      </SidebarProvider>
    </UpdateCheckProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchRemote.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UserMenu", () => {
  it("shows the server version under Admin, without a leading v", async () => {
    fetchRemote.mockResolvedValue({ version: "2.1.0" });
    renderMenu();
    expect(await screen.findByText("2.1.0")).toBeInTheDocument();
  });

  it("warns once about a newer release after the silent-check delay", async () => {
    fetchRemote.mockResolvedValue({ version: "v2.2.0", changelog: "Fixes", download: "https://x" });
    renderMenu();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SILENT_CHECK_DELAY_MS - 100);
    });
    expect(fetchRemote).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0]?.[1]).toMatchObject({ duration: 5200 });
  });

  it("stays silent when the remote version is the same", async () => {
    fetchRemote.mockResolvedValue({ version: "2.1.0" });
    renderMenu();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SILENT_CHECK_DELAY_MS + 100);
    });
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("stays silent when the silent check fails", async () => {
    fetchRemote.mockRejectedValue(new Error("offline"));
    renderMenu();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SILENT_CHECK_DELAY_MS + 100);
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("a manual check reports an up-to-date version", async () => {
    fetchRemote.mockResolvedValue({ version: "2.1.0" });
    const { user } = renderMenu();
    await screen.findByText("2.1.0");
    await user.click(screen.getByRole("button", { name: "Admin menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Check for updates" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(toast.success).toHaveBeenCalledWith(expect.any(String), { duration: 3600 });
  });
});

describe("UserMenu links", () => {
  it("opens GitHub in a new tab from the Admin menu", async () => {
    fetchRemote.mockResolvedValue({ version: "2.1.0" });
    const { user } = renderMenu();
    await user.click(screen.getByRole("button", { name: "Admin menu" }));
    const github = await screen.findByRole("menuitem", { name: "GitHub" });
    expect(github).toHaveAttribute("href", "https://github.com/tanu360/kiro-reverse-api");
    expect(github).toHaveAttribute("target", "_blank");
  });
});
