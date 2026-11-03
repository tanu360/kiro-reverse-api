import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type {
  FirstRunResponse,
  SessionCreateResponse,
  SessionTicketResponse,
  SuccessResponse,
} from "./types";

/** POST /session, auth: false. The only request that ever carries the admin password. */
export function createSession(password: string): Promise<SessionCreateResponse> {
  return apiRequest("/session", { method: "POST", body: { password }, auth: false });
}

/** DELETE /session */
export function deleteSession(): Promise<SuccessResponse> {
  return apiRequest("/session", { method: "DELETE" });
}

/** POST /session/ticket: a single-use ticket for the SSE stream (30 s). */
export function createTicket(): Promise<SessionTicketResponse> {
  return apiRequest("/session/ticket", { method: "POST" });
}

/** GET /first-run, auth: false */
export function getFirstRun(): Promise<FirstRunResponse> {
  return apiRequest("/first-run", { auth: false });
}

export function firstRunQuery() {
  return queryOptions({
    queryKey: queryKeys.firstRun,
    queryFn: getFirstRun,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
