import type { JSX, ReactNode } from "react";
import type { AdminEventType } from "@/lib/api/types";

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

export type AdminEventsStatus = "connecting" | "open" | "closed";

/** Skeleton: Task 3 opens /admin/api/events with a ticket and invalidates queries. */
export function AdminEventsProvider(props: {
  children: ReactNode;
  createEventSource?: (url: string) => EventSourceLike;
  reconnectDelayMs?: number;
}): JSX.Element {
  return <>{props.children}</>;
}

export function useAdminEventsStatus(): AdminEventsStatus {
  return "closed";
}

export function useAdminEvent(_type: AdminEventType, _handler: (event: AdminEvent) => void): void {}
