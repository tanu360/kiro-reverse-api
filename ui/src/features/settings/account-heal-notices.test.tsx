import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/api/query-keys";
import { AdminEventsProvider, type EventSourceLike } from "@/lib/events/admin-events";
import { toast } from "@/lib/toast";
import { renderWithProviders } from "@/test/render";
import { AccountHealNotices, HALTED_TOAST_ID } from "./account-heal-notices";

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
  it("toasts a heal and refetches the card, the accounts and the status", async () => {
    const { emit, queryClient } = await renderNotices();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    emit("healed:2");

    expect(
      await screen.findByText("Self-heal brought 2 accounts back into rotation."),
    ).toBeInTheDocument();
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([queryKeys.settings.all, queryKeys.accounts.list(), queryKeys.status]),
    );
  });

  it("warns once on a halt, with a way to Settings, and closes it on recovery", async () => {
    const warning = vi.spyOn(toast, "warning");
    const dismiss = vi.spyOn(toast, "dismiss");
    const { emit } = await renderNotices();

    emit("halted:5");

    expect(
      await screen.findByText(
        "Self-heal stopped because accounts keep failing after each heal. Check the accounts.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();
    expect(warning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ id: HALTED_TOAST_ID, duration: 0 }),
    );

    emit("recovered");
    expect(dismiss).toHaveBeenCalledWith(HALTED_TOAST_ID);
  });

  it("stays quiet for a heal that restored nothing", async () => {
    const info = vi.spyOn(toast, "info");
    const { emit } = await renderNotices();
    emit("healed:0");
    emit("resumed");
    expect(info).not.toHaveBeenCalled();
  });
});
