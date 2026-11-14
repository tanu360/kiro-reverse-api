import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type {
  FirstRunResponse,
  SessionChallengeResponse,
  SessionCreateResponse,
  SessionTicketResponse,
  SuccessResponse,
} from "./types";

/**
 * POST /session, auth: false. The only request that ever carries the admin password. With
 * two-factor sign-in on, the answer is a challenge instead of a token.
 */
export function createSession(
  password: string,
): Promise<SessionCreateResponse | SessionChallengeResponse> {
  return apiRequest("/session", { method: "POST", body: { password }, auth: false });
}

/** The second step: a code from the authenticator app, or a recovery code instead. */
export interface SecondFactor {
  code?: string;
  recoveryCode?: string;
}

/**
 * POST /session with the challenge and a code, auth: false. 401 `totp_invalid`, `totp_reused`
 * or `totp_challenge_expired` (enter the password again); 429 with Retry-After.
 */
export function completeSession(
  challenge: string,
  factor: SecondFactor,
): Promise<SessionCreateResponse> {
  return apiRequest("/session", {
    method: "POST",
    body: { challenge, ...factor },
    auth: false,
  });
}

export function isChallenge(
  res: SessionCreateResponse | SessionChallengeResponse | undefined,
): res is SessionChallengeResponse {
  return Boolean(res && "twoFactorRequired" in res && res.twoFactorRequired && res.challenge);
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
