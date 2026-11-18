import { queryOptions } from "@tanstack/react-query";
import { act, screen } from "@testing-library/react";
import { http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { fetchRemoteVersion } from "@/lib/api/system";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl, jsonError } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { freshMockUpdate } from "@/lib/mocks/update";
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
  statusQuery: () =>
    queryOptions({
      queryKey: ["status"],
      queryFn: () => Promise.resolve({}),
    }),
  fetchRemoteVersion: vi.fn(),
  fetchReleaseReady: vi.fn(() => Promise.resolve(true)),
  compareVersions: (a: string, b: string) =>
    a.replace(/^v/, "").localeCompare(b.replace(/^v/, ""), undefined, { numeric: true }),
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
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NavFooter update card", () => {
  afterEach(() => {
    mockDb.server = "docker";
    mockDb.update = freshMockUpdate();
  });

  it("shows no card or bell while the running version is the latest", async () => {
    fetchRemote.mockResolvedValue({ version: "2.1.0" });
    renderFooter();
    await passSilentCheck();
    expect(screen.queryByText("New version")).toBeNull();
    expect(screen.queryByRole("button", { name: /Update available/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Admin menu/ })).toBeInTheDocument();
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
    // A server that updates by hand gets no download button on the card.
    expect(screen.queryByRole("button", { name: "Download update" })).toBeNull();
    // The icon rail's bell, hidden by CSS while expanded, opens the same dialog.
    expect(screen.getByRole("button", { name: "Update available: 2.2.0" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "See what's new" }));
    expect(await screen.findByText("Version update")).toBeInTheDocument();
  });

  it("reads a newer release out once, then not on the next visit", async () => {
    fetchRemote.mockResolvedValue({ version: "v2.2.0", changelog: "", download: "https://x" });
    const first = renderFooter();
    await passSilentCheck();
    const line = await screen.findByText("Version 2.2.0 is available.");
    expect(line.closest('[data-slot="live-announcer"]')).not.toBeNull();
    first.unmount();

    renderFooter();
    await passSilentCheck();
    await screen.findByText("Kiro Proxy 2.2.0");
    expect(screen.queryByText("Version 2.2.0 is available.")).toBeNull();
  });

  it("downloads from the card on a server that updates itself, then offers the restart", async () => {
    mockDb.server = "binary";
    fetchRemote.mockResolvedValue({ version: "v2.2.0", changelog: "🔑 New keys" });
    const { user } = renderFooter();
    await passSilentCheck();

    expect(await screen.findByText("New version")).toBeInTheDocument();
    const button = screen
      .getAllByRole("button", { name: "Download update" })
      .find((element) => element.dataset.slot === "update-status-button");
    expect(button).toBeDefined();
    await user.click(button as HTMLElement);
    // The eyebrow says how far it got (the rail's button says the same, hidden while expanded).
    expect((await screen.findAllByText(/^Downloading/)).length).toBeGreaterThan(0);

    // The mock's download takes six seconds; the next poll finds it in place.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    expect(
      (await screen.findAllByText("Ready to install", {}, { timeout: 4000 })).length,
    ).toBeGreaterThan(0);
    // The card's own button offers the restart (no toast).
    const restart = screen
      .getAllByRole("button", { name: "Restart to update" })
      .find((element) => element.dataset.slot === "update-status-button");
    expect(restart).toBeDefined();
  });

  it("says in the card why a download did not start, and Try again sends it again", async () => {
    mockDb.server = "binary";
    let fail = true;
    mockServer.use(
      http.post(apiUrl("/update"), () => (fail ? jsonError(500, "disk is full") : undefined)),
    );
    fetchRemote.mockResolvedValue({ version: "v2.2.0", changelog: "🔑 New keys" });
    const { user } = renderFooter();
    await passSilentCheck();

    const card = await screen.findByText("Kiro Proxy 2.2.0");
    const statusButton = () =>
      screen
        .getAllByRole("button")
        .find((element) => element.dataset.slot === "update-status-button") as HTMLElement;
    await user.click(statusButton());
    expect(await screen.findByText("disk is full")).toBeInTheDocument();
    expect(card.closest('[data-slot="sidebar-update-card"]')).toHaveTextContent("Update failed");
    expect(screen.queryByText("New keys")).toBeNull();

    fail = false;
    expect(statusButton()).toHaveAccessibleName("Try again");
    await user.click(statusButton());
    expect((await screen.findAllByText(/^Downloading/)).length).toBeGreaterThan(0);
    expect(screen.queryByText("disk is full")).toBeNull();
  });

  it("says in the card why a download failed", async () => {
    mockDb.server = "fail";
    fetchRemote.mockResolvedValue({ version: "v2.2.0", changelog: "🔑 New keys" });
    const { user } = renderFooter();
    await passSilentCheck();
    await screen.findByText("Kiro Proxy 2.2.0");
    const button = screen
      .getAllByRole("button", { name: "Download update" })
      .find((element) => element.dataset.slot === "update-status-button");
    await user.click(button as HTMLElement);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(
      await screen.findByText(
        "The download does not match the release checksum.",
        {},
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
  });
});
