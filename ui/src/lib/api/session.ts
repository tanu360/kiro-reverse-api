import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "./query-keys";
import type {
  FirstRunResponse,
  SessionCreateResponse,
  SessionTicketResponse,
  SuccessResponse,
} from "./types";

const notImplemented = () => Promise.reject(new Error("not implemented"));

/** POST /session, auth: false */
export function createSession(_password: string): Promise<SessionCreateResponse> {
  return notImplemented();
}

/** DELETE /session */
export function deleteSession(): Promise<SuccessResponse> {
  return notImplemented();
}

/** POST /session/ticket */
export function createTicket(): Promise<SessionTicketResponse> {
  return notImplemented();
}

/** GET /first-run, auth: false */
export function getFirstRun(): Promise<FirstRunResponse> {
  return notImplemented();
}

export function firstRunQuery() {
  return queryOptions({
    queryKey: queryKeys.firstRun,
    queryFn: getFirstRun,
    staleTime: 0,
  });
}
