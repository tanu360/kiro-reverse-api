import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/api/query-keys";
import { AdminEventsProvider, type EventSourceLike } from "@/lib/events/admin-events";
import { renderWithProviders } from "@/test/render";
import { AccountHealNotices } from "./account-heal-notices";

vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/session")>();
  return {
    ...actual,
    createTicket: vi.fn(async () => ({ ticket: "ticket-1", expiresAt: Date.now() + 30_000 })),
  };
});

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {}

  emit(type: string, payload: string): void {
    const data = JSON.stringify({ type, payload });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }
}

afterEach(() => {
  FakeEventSource.instances = [];
  vi.restoreAllMocks();
});

async function renderNotices() {
  const result = renderWithProviders(
    <AdminEventsProvider createEventSource={(url) => new FakeEventSource(url)}>
      <AccountHealNotices />
    </AdminEventsProvider>,
  );
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = FakeEventSource.instances[0];
  return { ...result, emit: (payload: string) => act(() => source.emit("account_heal", payload)) };
}

describe("AccountHealNotices", () => {
  it("reads out a heal and refetches the card, the accounts and the status", async () => {
    const { emit, queryClient } = await renderNotices();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    emit("healed:2");

    const line = await screen.findByText("Self-heal brought 2 accounts back into rotation.");
    expect(line.closest('[data-slot="live-announcer"]')).not.toBeNull();
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([queryKeys.settings.all, queryKeys.accounts.list(), queryKeys.status]),
    );
  });

  it("warns on a halt in one line, with a way to Settings, and drops it on recovery", async () => {
    const { emit } = await renderNotices();

    emit("halted:5");

    const notice = (
      await screen.findByText(
        "Self-heal stopped because accounts keep failing after each heal. Check the accounts.",
      )
    ).closest("[role=alert]") as HTMLElement;
    expect(notice).not.toBeNull();
    expect(within(notice).getByRole("button", { name: "Open settings" })).toBeInTheDocument();
    // Another halt keeps the one line.
    emit("halted:5");
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    emit("recovered");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops the halt line on a resume, or when it is closed", async () => {
    const { emit, user } = await renderNotices();
    emit("halted:5");
    await screen.findByRole("alert");
    emit("resumed");
    expect(screen.queryByRole("alert")).toBeNull();

    emit("halted:5");
    await user.click(
      within(await screen.findByRole("alert")).getByRole("button", { name: "Close" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays quiet for a heal that restored nothing", async () => {
    const { emit } = await renderNotices();
    emit("healed:0");
    emit("resumed");
    expect(document.querySelector('[data-slot="live-announcer"]')?.textContent).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
