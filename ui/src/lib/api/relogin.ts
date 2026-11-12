import { apiRequest } from "./client";
import { isApiError } from "./errors";
import type { AddAccountResponse, ReloginMismatchBody, SuccessResponse } from "./types";

const reloginPath = (id: string, action: "confirm" | "discard") =>
  `/accounts/${encodeURIComponent(id)}/relogin/${action}`;

/** Applies a stashed login whose user differs from the account's ("Replace identity"). */
export function confirmRelogin(id: string, pendingId: string): Promise<AddAccountResponse> {
  return apiRequest(reloginPath(id, "confirm"), { method: "POST", body: { pendingId } });
}

/** Drops a stashed login at once. Never throws: the server forgets it in 10 minutes anyway. */
export async function discardRelogin(id: string, pendingId: string): Promise<void> {
  try {
    await apiRequest<SuccessResponse>(reloginPath(id, "discard"), {
      method: "POST",
      body: { pendingId },
    });
  } catch {
    // Nothing to do: the stash expires on its own.
  }
}

/** The 409 body of a re-login that signed in as another user, or null for any other error. */
export function reloginMismatch(error: unknown): ReloginMismatchBody | null {
  if (!isApiError(error) || error.status !== 409) return null;
  const body = error.body as Partial<ReloginMismatchBody> | null;
  if (body?.code !== "relogin_identity_mismatch" || typeof body.pendingId !== "string") {
    return null;
  }
  return {
    success: false,
    error: typeof body.error === "string" ? body.error : "",
    code: "relogin_identity_mismatch",
    pendingId: body.pendingId,
    accountId: typeof body.accountId === "string" ? body.accountId : "",
    currentEmail: typeof body.currentEmail === "string" ? body.currentEmail : "",
    incomingEmail: typeof body.incomingEmail === "string" ? body.incomingEmail : "",
    expiresIn: typeof body.expiresIn === "number" ? body.expiresIn : 0,
  };
}
