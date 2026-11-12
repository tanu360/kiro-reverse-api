import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type JSX,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { API_BASE } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";
import { createTicket } from "@/lib/api/session";
import type { AdminEventType } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";

export type { AdminEventType };

export interface AdminEvent {
  type: AdminEventType;
  payload?: string;
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
}

type AdminEventsStatus = "connecting" | "open" | "closed";

// `account_updated` and `accounts_refreshed` are not listed: Go never publishes them.
const EVENT_TYPES: readonly AdminEventType[] = [
  "hello",
  "observe_tick",
  "backup_created",
  "backup_restored",
  "backup_deleted",
  "accounts_changed",
  "api_keys_changed",
  "settings_changed",
  "stats_reset",
];

const OBSERVE_DEBOUNCE_MS = 1200;
/** A batch action or a background sweep sends one change event per row; refetch once. */
export const CHANGE_DEBOUNCE_MS = 300;

type ChangeEventType =
  | "backup_deleted"
  | "accounts_changed"
  | "api_keys_changed"
  | "settings_changed"
  | "stats_reset";

/**
 * What each change event refetches. Account events refresh the list only: the detail queries
 * under accounts.all call AWS, and a background sweep changes every account. The overview's
 * enabled and available counts come from the accounts and allowOverUsage, so account and
 * settings events refresh it too, at once, without waiting for the server's next observe_tick.
 */
const CHANGE_INVALIDATIONS: Record<ChangeEventType, ReadonlyArray<readonly unknown[]>> = {
  accounts_changed: [
    queryKeys.accounts.list(),
    queryKeys.accounts.duplicates(),
    queryKeys.status,
    queryKeys.observe.overview(),
  ],
  api_keys_changed: [queryKeys.apiKeys.all],
  settings_changed: [queryKeys.settings.all, queryKeys.observe.overview()],
  stats_reset: [
    queryKeys.status,
    queryKeys.observe.all,
    queryKeys.requests.all,
    queryKeys.settings.logRetention(),
    queryKeys.apiKeys.all,
  ],
  backup_deleted: [queryKeys.backups.all],
};

function isChangeEvent(type: AdminEventType): type is ChangeEventType {
  return Object.hasOwn(CHANGE_INVALIDATIONS, type);
}

type Handler = (event: AdminEvent) => void;
type Registry = Map<AdminEventType, Set<{ current: Handler }>>;

const StatusContext = createContext<AdminEventsStatus>("closed");
const RegistryContext = createContext<Registry | null>(null);

function parsePayload(event: MessageEvent): string | undefined {
  if (typeof event.data !== "string" || !event.data) return undefined;
  try {
    const data: unknown = JSON.parse(event.data);
    if (typeof data === "object" && data !== null) {
      const payload = (data as { payload?: unknown }).payload;
      return typeof payload === "string" && payload ? payload : undefined;
    }
  } catch {
    // Not JSON: no payload.
  }
  return undefined;
}

function defaultEventSource(): ((url: string) => EventSourceLike) | null {
  if (typeof EventSource === "undefined") return null;
  return (url) => new EventSource(url);
}

/**
 * Opens /admin/api/events once per session and turns server events into query invalidations.
 * EventSource cannot send headers, so every (re)connect first fetches a single-use ticket. On
 * error the source is closed (the browser's own reconnect would reuse the dead ticket) and a
 * fresh ticket is requested after `reconnectDelayMs`.
 */
export function AdminEventsProvider(props: {
  children: ReactNode;
  createEventSource?: (url: string) => EventSourceLike;
  reconnectDelayMs?: number;
}): JSX.Element {
  const { children, createEventSource, reconnectDelayMs = 5000 } = props;
  const queryClient = useQueryClient();
  const token = useSession()?.token ?? null;
  const [status, setStatus] = useState<AdminEventsStatus>("closed");
  const [registry] = useState<Registry>(() => new Map());
  const factoryRef = useRef(createEventSource);
  factoryRef.current = createEventSource;

  useEffect(() => {
    const factory = factoryRef.current ?? defaultEventSource();
    if (!token || !factory) {
      setStatus("closed");
      return;
    }

    let disposed = false;
    let source: EventSourceLike | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let observeTimer: ReturnType<typeof setTimeout> | null = null;
    // The observe store's change counter from the last observe_tick on this connection.
    let observeSeq: string | undefined;
    const changeTimers = new Map<ChangeEventType, ReturnType<typeof setTimeout>>();

    const react = (event: AdminEvent) => {
      if (isChangeEvent(event.type) && !changeTimers.has(event.type)) {
        const type = event.type;
        changeTimers.set(
          type,
          setTimeout(() => {
            changeTimers.delete(type);
            for (const queryKey of CHANGE_INVALIDATIONS[type]) {
              void queryClient.invalidateQueries({ queryKey });
            }
          }, CHANGE_DEBOUNCE_MS),
        );
      }
      if (event.type === "observe_tick" && event.payload !== undefined) {
        // The payload is the store's change counter: a repeat carries no new data. Every new
        // one refetches, whether traffic, a minute ending or an account count moved it.
        if (event.payload === observeSeq) return;
        observeSeq = event.payload;
      }
      switch (event.type) {
        case "hello":
          setStatus("open");
          break;
        case "observe_tick":
          // One pending timer: a burst of ticks refetches once. Only mounted observe queries
          // refetch, and windows marked liveRefresh:false poll on their own instead.
          if (observeTimer) break;
          observeTimer = setTimeout(() => {
            observeTimer = null;
            void queryClient.invalidateQueries({
              queryKey: queryKeys.observe.all,
              refetchType: "active",
              predicate: (query) => query.meta?.liveRefresh !== false,
            });
          }, OBSERVE_DEBOUNCE_MS);
          break;
        case "backup_created":
          void queryClient.invalidateQueries({
            queryKey: queryKeys.backups.all,
            refetchType: "active",
          });
          break;
        case "backup_restored":
          // The server also revoked every session, so the next call 401s anyway.
          for (const queryKey of [
            queryKeys.accounts.all,
            queryKeys.settings.all,
            queryKeys.backups.all,
            queryKeys.status,
          ]) {
            void queryClient.invalidateQueries({ queryKey });
          }
          break;
      }
      for (const handler of registry.get(event.type) ?? []) handler.current(event);
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, reconnectDelayMs);
    };

    const connect = async () => {
      if (disposed) return;
      setStatus("connecting");
      let ticket: string;
      try {
        ticket = (await createTicket()).ticket;
      } catch {
        // A 401 here clears the session and this effect re-runs without a token.
        if (!disposed) {
          setStatus("closed");
          scheduleReconnect();
        }
        return;
      }
      if (disposed) return;
      const es = factory(`${API_BASE}/events?ticket=${encodeURIComponent(ticket)}`);
      source = es;
      observeSeq = undefined;
      es.onopen = () => {
        if (source === es) setStatus("open");
      };
      es.onerror = () => {
        es.close();
        if (source !== es) return;
        source = null;
        setStatus("closed");
        scheduleReconnect();
      };
      for (const type of EVENT_TYPES) {
        es.addEventListener(type, (event) => {
          if (source === es) react({ type, payload: parsePayload(event) });
        });
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (observeTimer) clearTimeout(observeTimer);
      for (const timer of changeTimers.values()) clearTimeout(timer);
      changeTimers.clear();
      source?.close();
      source = null;
    };
  }, [token, reconnectDelayMs, queryClient, registry]);

  return (
    <RegistryContext.Provider value={registry}>
      <StatusContext.Provider value={token ? status : "closed"}>{children}</StatusContext.Provider>
    </RegistryContext.Provider>
  );
}

export function useAdminEventsStatus(): AdminEventsStatus {
  return useContext(StatusContext);
}

/** Runs `handler` for every `type` event, after the provider's own query invalidations. */
export function useAdminEvent(type: AdminEventType, handler: (event: AdminEvent) => void): void {
  const registry = useContext(RegistryContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!registry) return;
    const entry = { current: (event: AdminEvent) => handlerRef.current(event) };
    let set = registry.get(type);
    if (!set) {
      set = new Set();
      registry.set(type, set);
    }
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }, [registry, type]);
}
