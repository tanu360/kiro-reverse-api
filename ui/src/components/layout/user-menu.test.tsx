import { queryOptions } from "@tanstack/react-query";
import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { subscribeAnnouncements } from "@/lib/announce";
import { fetchReleaseReady, fetchRemoteVersion } from "@/lib/api/system";
import { renderWithProviders } from "@/test/render";
import { CHECK_RESULT_MS, SILENT_CHECK_DELAY_MS, UpdateCheckProvider } from "./update-check";
import { UserMenu } from "./user-menu";

const { getStatus } = vi.hoisted(() => ({ getStatus: vi.fn() }));

vi.mock("@/lib/api/system", () => {
  const parts = (v: string) =>
    v
      .replace(/^v/i, "")
      .split(".")
      .map((n) => Number(n) || 0);
  return {
    statusQuery: () =>
      queryOptions({
        queryKey: ["status"],
        queryFn: getStatus,
        retry: false,
      }),
    versionQuery: () =>
      queryOptions({
        queryKey: ["version"],
        queryFn: () => Promise.resolve({ version: "v2.1.0" }),
        staleTime: Number.POSITIVE_INFINITY,
      }),
    fetchRemoteVersion: vi.fn(),
    fetchReleaseReady: vi.fn(),
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
const fetchRemote = vi.mocked(fetchRemoteVersion);
const releaseReady = vi.mocked(fetchReleaseReady);

/** Read out by the app's live region (lib/announce), not shown. */
function announced(text: string | RegExp): HTMLElement | null {
  const region = document.querySelector<HTMLElement>('[data-slot="live-announcer"]');
  return region ? within(region).queryByText(text) : null;
}

/** Everything the live region holds now. */
function announcerText(): string {
  return document.querySelector('[data-slot="live-announcer"]')?.textContent ?? "";
}

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
  releaseReady.mockReset().mockResolvedValue(true);
  getStatus.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UserMenu", () => {
  it("names the proxy online while /status answers", async () => {
    renderMenu();
    expect(
      await screen.findByRole("button", { name: "Admin menu, Proxy online" }),
    ).toBeInTheDocument();
  });

  it("names the proxy unreachable once /status fails", async () => {
    getStatus.mockRejectedValue(new Error("down"));
    renderMenu();
    expect(
      await screen.findByRole("button", { name: "Admin menu, Proxy unreachable" }),
    ).toBeInTheDocument();
  });

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
    expect(announced(/is available/)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(announced("Version 2.2.0 is available.")).not.toBeNull());
  });

  it("stays silent when the remote version is the same", async () => {
    fetchRemote.mockResolvedValue({ version: "2.1.0" });
    renderMenu();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SILENT_CHECK_DELAY_MS + 100);
    });
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    expect(announcerText()).toBe("");
  });

  it("stays silent about a newer version whose release files are not out yet", async () => {
    fetchRemote.mockResolvedValue({ version: "v2.2.0", changelog: "Fixes", download: "https://x" });
    releaseReady.mockResolvedValue(false);
    renderMenu();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SILENT_CHECK_DELAY_MS + 100);
    });
    expect(releaseReady).toHaveBeenCalledWith("v2.2.0");
    expect(announcerText()).toBe("");
  });

  it("stays silent when the silent check fails", async () => {
    fetchRemote.mockRejectedValue(new Error("offline"));
    renderMenu();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SILENT_CHECK_DELAY_MS + 100);
    });
    expect(announcerText()).toBe("");
  });

  it("a manual check says an up-to-date version on its row, then goes back", async () => {
    fetchRemote.mockResolvedValue({ version: "2.1.0" });
    const { user } = renderMenu();
    await screen.findByText("2.1.0");
    await user.click(screen.getByRole("button", { name: /^Admin menu/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Check for updates" }));
    expect(
      await screen.findByRole("menuitem", { name: "Kiro Proxy is up to date." }),
    ).toBeInTheDocument();
    await vi.waitFor(() => expect(announced("Kiro Proxy is up to date.")).not.toBeNull());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_RESULT_MS);
    });
    expect(screen.getByRole("menuitem", { name: "Check for updates" })).toBeInTheDocument();
  });

  it("a failed manual check says so on its row, and a click checks again", async () => {
    fetchRemote.mockRejectedValueOnce(new Error("offline"));
    fetchRemote.mockResolvedValue({ version: "2.1.0" });
    const { user } = renderMenu();
    await screen.findByText("2.1.0");
    await user.click(screen.getByRole("button", { name: /^Admin menu/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Check for updates" }));
    const failed = await screen.findByRole("menuitem", { name: "Could not check for updates." });
    await vi.waitFor(() =>
      expect(
        announced("Could not check for updates. GitHub did not answer. Try again later."),
      ).not.toBeNull(),
    );

    await user.click(failed);
    expect(
      await screen.findByRole("menuitem", { name: "Kiro Proxy is up to date." }),
    ).toBeInTheDocument();
  });

  it("a manual check reports up to date while the newer release has no files yet", async () => {
    fetchRemote.mockResolvedValue({ version: "2.2.0" });
    releaseReady.mockResolvedValue(false);
    const { user } = renderMenu();
    await screen.findByText("2.1.0");
    await user.click(screen.getByRole("button", { name: /^Admin menu/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Check for updates" }));
    expect(
      await screen.findByRole("menuitem", { name: "Kiro Proxy is up to date." }),
    ).toBeInTheDocument();
    expect(announced(/is available/)).toBeNull();
  });
});

describe("UserMenu with a newer release known", () => {
  it("drops Check for updates and carries no copy of the update", async () => {
    fetchRemote.mockResolvedValue({ version: "v2.2.0", changelog: "", download: "https://x" });
    const { user } = renderMenu();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SILENT_CHECK_DELAY_MS + 100);
    });
    await user.click(screen.getByRole("button", { name: /^Admin menu/ }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Help & docs",
      "Report an issue",
      "GitHub",
      "Sign out",
    ]);
  });
});

describe("UserMenu manual check", () => {
  it("keeps the menu open with a busy row while it checks, then says the answer there", async () => {
    let answer: (value: { version: string }) => void = () => {};
    fetchRemote.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { user } = renderMenu();
    await screen.findByText("2.1.0");
    await user.click(screen.getByRole("button", { name: /^Admin menu/ }));
    const item = await screen.findByRole("menuitem", { name: "Check for updates" });
    await user.click(item);
    // Still open, same label, marked busy, and a status says it is checking.
    expect(screen.getByRole("menuitem", { name: "Check for updates" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Checking…");

    await act(async () => {
      answer({ version: "2.1.0" });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(
      await screen.findByRole("menuitem", { name: "Kiro Proxy is up to date." }),
    ).not.toHaveAttribute("aria-busy");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("drops the answer of a check that outlives the shell", async () => {
    let answer: (value: { version: string }) => void = () => {};
    fetchRemote.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const heard: string[] = [];
    const stop = subscribeAnnouncements(({ text }) => heard.push(text));
    const { user, unmount } = renderMenu();
    await screen.findByText("2.1.0");
    await user.click(screen.getByRole("button", { name: /^Admin menu/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Check for updates" }));
    // Signed out while it runs: the shell goes, then GitHub answers.
    unmount();
    await act(async () => {
      answer({ version: "2.1.0" });
      await vi.advanceTimersByTimeAsync(10);
    });
    stop();
    expect(heard).toEqual([]);
  });

  it("closes the menu and opens the update dialog when the check finds a release", async () => {
    fetchRemote.mockResolvedValueOnce({ version: "2.1.0" });
    const { user } = renderMenu();
    await screen.findByText("2.1.0");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SILENT_CHECK_DELAY_MS + 100);
    });
    fetchRemote.mockResolvedValue({ version: "v2.2.0", changelog: "Fixes", download: "https://x" });
    await user.click(screen.getByRole("button", { name: /^Admin menu/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Check for updates" }));
    expect(await screen.findByText("Version update")).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("UserMenu links", () => {
  it("opens GitHub in a new tab from the Admin menu", async () => {
    fetchRemote.mockResolvedValue({ version: "2.1.0" });
    const { user } = renderMenu();
    await user.click(screen.getByRole("button", { name: /^Admin menu/ }));
    const github = await screen.findByRole("menuitem", { name: "GitHub" });
    expect(github).toHaveAttribute("href", "https://github.com/tanu360/kiro-reverse-api");
    expect(github).toHaveAttribute("target", "_blank");
  });

  it("opens the README and the issue tracker on GitHub in a new tab", async () => {
    fetchRemote.mockResolvedValue({ version: "2.1.0" });
    const { user } = renderMenu();
    await user.click(screen.getByRole("button", { name: /^Admin menu/ }));
    const docs = await screen.findByRole("menuitem", { name: "Help & docs" });
    const issue = screen.getByRole("menuitem", { name: "Report an issue" });
    expect(docs).toHaveAttribute("href", "https://github.com/tanu360/kiro-reverse-api#readme");
    expect(issue).toHaveAttribute("href", "https://github.com/tanu360/kiro-reverse-api/issues");
    expect(docs).toHaveAttribute("target", "_blank");
    expect(issue).toHaveAttribute("target", "_blank");
  });
});
