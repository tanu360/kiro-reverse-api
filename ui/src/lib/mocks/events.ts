import type { AdminEventType } from "@/lib/api/types";

// The mock's side of /admin/api/events: handlers publish here, the SSE stream in
// core-handlers.ts forwards to every open connection, as the Go broadcaster does.

type Listener = (type: AdminEventType, payload?: string) => void;

const listeners = new Set<Listener>();

export function onMockEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** backup_created with the backup id, backup_restored with the id or "upload" (proxy/backups_api.go). */
export function publishMockEvent(type: AdminEventType, payload?: string): void {
  for (const listener of listeners) listener(type, payload);
}
