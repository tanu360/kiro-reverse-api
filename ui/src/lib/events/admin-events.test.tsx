import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/api/query-keys";
import { createTicket } from "@/lib/api/session";
import { clearSession, setSession } from "@/lib/auth/session";
import {
  type AdminEvent,
  AdminEventsProvider,
  type EventSourceLike,
  useAdminEvent,
  useAdminEventsStatus,
} from "./admin-events";

vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/session")>();
  let n = 0;
  return {
    ...actual,
    createTicket: vi.fn(async () => {
      n += 1;
      return { ticket: `ticket-${n}`, expiresAt: Date.now() + 30_000 };
    }),
  };
});

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data = "{}"): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }
}

const createFake = (url: string) => new FakeEventSource(url);
const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

/** Lets pending promises (the ticket request) settle without moving the clock. */
async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function Status() {
  return <output data-testid="status">{useAdminEventsStatus()}</output>;
}

/** One live observe query and one window marked liveRefresh: false. */
function Observers(props: { live: () => Promise<string>; slow: () => Promise<string> }) {
  useQuery({ queryKey: queryKeys.observe.overview(), queryFn: props.live });
  useQuery({
    queryKey: queryKeys.observe.heatmap(360),
    queryFn: props.slow,
    meta: { liveRefresh: false },
  });
  return null;
}

function Listener(props: { onEvent: (event: AdminEvent) => void }) {
  useAdminEvent("backup_created", props.onEvent);
  return null;
}

function renderProvider(children: ReactNode = <Status />, client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <AdminEventsProvider createEventSource={createFake}>{children}</AdminEventsProvider>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.mocked(createTicket).mockClear();
  setSession({ token: "mock-token", expiresAt: Date.now() + 3_600_000, remember: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AdminEventsProvider", () => {
  it("requests a ticket and opens the stream with ?ticket=", async () => {
    renderProvider();
    expect(screen.getByTestId("status")).toHaveTextContent("connecting");
    await flush();
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().url).toBe("/admin/api/events?ticket=ticket-1");
    act(() => latest().emit("hello"));
    expect(screen.getByTestId("status")).toHaveTextContent("open");
  });

  it("refetches active observe queries once, 1200 ms after a burst of ticks", async () => {
    const live = vi.fn(async () => "live");
    const slow = vi.fn(async () => "slow");
    const client = renderProvider(<Observers live={live} slow={slow} />);
    await flush();
    expect(live).toHaveBeenCalledTimes(1);
    expect(slow).toHaveBeenCalledTimes(1);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    act(() => latest().emit("observe_tick"));
    await advance(400);
    act(() => latest().emit("observe_tick"));
    await advance(400);
    act(() => latest().emit("observe_tick"));
    await advance(399);
    expect(invalidate).not.toHaveBeenCalled();

    await advance(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.observe.all, refetchType: "active" }),
    );
    await flush();
    expect(live).toHaveBeenCalledTimes(2);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("closes on error and reconnects after 5000 ms with a fresh ticket", async () => {
    renderProvider();
    await flush();
    const first = latest();
    act(() => first.onerror?.(new Event("error")));
    expect(first.closed).toBe(true);
    expect(screen.getByTestId("status")).toHaveTextContent("closed");

    await advance(4999);
    expect(FakeEventSource.instances).toHaveLength(1);
    await advance(1);
    expect(createTicket).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest().url).toMatch(/\?ticket=ticket-\d+$/);
    expect(latest().url).not.toBe(first.url);
  });

  it("closes the stream when the session ends", async () => {
    renderProvider();
    await flush();
    const source = latest();
    act(() => clearSession("signout"));
    expect(source.closed).toBe(true);
    expect(screen.getByTestId("status")).toHaveTextContent("closed");
    await advance(10_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("reconnects with a new ticket when the token changes", async () => {
    renderProvider();
    await flush();
    const first = latest();
    act(() =>
      setSession({ token: "mock-token-2", expiresAt: Date.now() + 3_600_000, remember: false }),
    );
    await flush();
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("invalidates accounts, settings, backups and status on backup_restored", async () => {
    const client = renderProvider();
    await flush();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    act(() => latest().emit("backup_restored", '{"type":"backup_restored","payload":"upload"}'));
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        queryKeys.accounts.all,
        queryKeys.settings.all,
        queryKeys.backups.all,
        queryKeys.status,
      ]),
    );
  });

  it("invalidates backups on backup_created and passes the payload to subscribers", async () => {
    const seen: AdminEvent[] = [];
    const client = renderProvider(<Listener onEvent={(event) => seen.push(event)} />);
    await flush();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    act(() => latest().emit("backup_created", '{"type":"backup_created","payload":"b-1"}'));
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.backups.all }),
    );
    expect(seen).toEqual([{ type: "backup_created", payload: "b-1" }]);
  });
});

describe("defaults", () => {
  it("reports 'closed' outside a provider", () => {
    render(<Status />);
    expect(screen.getByTestId("status")).toHaveTextContent("closed");
  });

  it("does nothing without EventSource or a factory", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AdminEventsProvider>
          <Status />
        </AdminEventsProvider>
      </QueryClientProvider>,
    );
    await flush();
    expect(createTicket).not.toHaveBeenCalled();
    expect(screen.getByTestId("status")).toHaveTextContent("closed");
  });
});
