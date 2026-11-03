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
  SsoTokenImportResult,
} from "./types";

const notImplemented = () => Promise.reject(new Error("not implemented"));

export function startIamSso(_req: IamSsoStartRequest): Promise<IamSsoStartResponse> {
  return notImplemented();
}

export function completeIamSso(_req: IamSsoCompleteRequest): Promise<IamSsoCompleteResponse> {
  return notImplemented();
}

export function startMicrosoftSso(): Promise<MicrosoftStartResponse> {
  return notImplemented();
}

export function completeMicrosoftSso(
  _req: MicrosoftCompleteRequest,
): Promise<MicrosoftCompleteResponse> {
  return notImplemented();
}

export function selectMicrosoftProfile(
  _req: MicrosoftSelectProfileRequest,
): Promise<MicrosoftSelectProfileResponse> {
  return notImplemented();
}

/** Never throws. */
export function cancelMicrosoftSso(_req: MicrosoftCancelRequest): Promise<void> {
  return Promise.resolve();
}

export function startBuilderId(_req: BuilderIdStartRequest): Promise<BuilderIdStartResponse> {
  return notImplemented();
}

export function pollBuilderId(_req: BuilderIdPollRequest): Promise<BuilderIdPollResponse> {
  return notImplemented();
}

export function importSsoToken(_req: SsoTokenImportRequest): Promise<SsoTokenImportResult> {
  return notImplemented();
}

export function importCredentials(
  _req: CredentialsImportRequest,
): Promise<CredentialsImportResponse> {
  return notImplemented();
}
