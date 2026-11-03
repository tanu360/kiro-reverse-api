import { apiRequest } from "./client";
import type {
  BuilderIdPollRequest,
  BuilderIdPollResponse,
  BuilderIdStartRequest,
  BuilderIdStartResponse,
  CredentialsImportRequest,
  CredentialsImportResponse,
  IamSsoCompleteRequest,
  IamSsoCompleteResponse,
  IamSsoStartRequest,
  IamSsoStartResponse,
  MicrosoftCancelRequest,
  MicrosoftCompleteRequest,
  MicrosoftCompleteResponse,
  MicrosoftSelectProfileRequest,
  MicrosoftSelectProfileResponse,
  MicrosoftStartResponse,
  SsoTokenImportRequest,
  SsoTokenImportResponse,
  SsoTokenImportResult,
} from "./types";

export function startIamSso(req: IamSsoStartRequest): Promise<IamSsoStartResponse> {
  return apiRequest("/auth/iam-sso/start", { method: "POST", body: req });
}

export function completeIamSso(req: IamSsoCompleteRequest): Promise<IamSsoCompleteResponse> {
  return apiRequest("/auth/iam-sso/complete", { method: "POST", body: req });
}

export function startMicrosoftSso(): Promise<MicrosoftStartResponse> {
  return apiRequest("/auth/microsoft-sso/start", { method: "POST", body: {} });
}

export function completeMicrosoftSso(
  req: MicrosoftCompleteRequest,
): Promise<MicrosoftCompleteResponse> {
  return apiRequest("/auth/microsoft-sso/complete", { method: "POST", body: req });
}

export function selectMicrosoftProfile(
  req: MicrosoftSelectProfileRequest,
): Promise<MicrosoftSelectProfileResponse> {
  return apiRequest("/auth/microsoft-sso/select-profile", { method: "POST", body: req });
}

/** Fire-and-forget: frees the server-side login state. Never throws. */
export async function cancelMicrosoftSso(req: MicrosoftCancelRequest): Promise<void> {
  try {
    await apiRequest("/auth/microsoft-sso/cancel", { method: "POST", body: req });
  } catch {
    // Nothing to do: the server session expires on its own.
  }
}

export function startBuilderId(req: BuilderIdStartRequest): Promise<BuilderIdStartResponse> {
  return apiRequest("/auth/builderid/start", { method: "POST", body: req });
}

/** A failed poll is HTTP 400 with `success: false`, which the client throws as ApiError. */
export function pollBuilderId(req: BuilderIdPollRequest): Promise<BuilderIdPollResponse> {
  return apiRequest("/auth/builderid/poll", { method: "POST", body: req });
}

/** Partial success is 200 with `errors`; the server sends `errors: null` when there are none. */
export async function importSsoToken(req: SsoTokenImportRequest): Promise<SsoTokenImportResult> {
  const res = await apiRequest<SsoTokenImportResponse>("/auth/sso-token", {
    method: "POST",
    body: req,
  });
  return { ...res, accounts: res.accounts ?? [], errors: res.errors ?? [] };
}

export function importCredentials(
  req: CredentialsImportRequest,
): Promise<CredentialsImportResponse> {
  return apiRequest("/auth/credentials", { method: "POST", body: req });
}
