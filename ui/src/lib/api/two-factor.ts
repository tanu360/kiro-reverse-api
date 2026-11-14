import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";

/** GET /two-factor: admin two-factor sign-in, never its secret. */
export interface TwoFactorStatus {
  enabled: boolean;
  /** ms epoch */
  enabledAt?: number;
  recoveryCodesLeft: number;
  /** ADMIN_RESET_2FA is set: each start turns it off again, so setup is refused. */
  resetByEnv: boolean;
}

/** POST /two-factor/setup: a new secret to enrol, unconfirmed until enable. */
export interface TwoFactorSetup {
  /** Base32, for typing into an app that cannot scan. */
  secret: string;
  otpauthUrl: string;
  /** A standalone SVG of the otpauth:// QR code. */
  qrSvg: string;
  issuer: string;
  account: string;
  /** ms epoch; about 10 min */
  expiresAt: number;
}

/** Turning it on and replacing the recovery codes return the codes: the only time they show. */
export interface TwoFactorCodes {
  status: TwoFactorStatus;
  recoveryCodes: string[];
}

/** A change to two-factor sign-in proves the admin with one of these. */
export interface TwoFactorProof {
  code?: string;
  recoveryCode?: string;
  password?: string;
}

async function getTwoFactor(): Promise<TwoFactorStatus> {
  const res = await apiRequest<Partial<TwoFactorStatus>>("/two-factor");
  return {
    enabled: res.enabled === true,
    enabledAt: res.enabledAt,
    recoveryCodesLeft: res.recoveryCodesLeft ?? 0,
    resetByEnv: res.resetByEnv === true,
  };
}

export function twoFactorQuery() {
  return queryOptions({ queryKey: queryKeys.settings.twoFactor(), queryFn: getTwoFactor });
}

/** 409 `totp_already_enabled`, or `totp_reset_by_env` while ADMIN_RESET_2FA is set. */
export function startTwoFactorSetup(): Promise<TwoFactorSetup> {
  return apiRequest("/two-factor/setup", { method: "POST" });
}

/** 400 `totp_invalid`, or `totp_setup_expired` after 10 min. Ends every other session. */
export function enableTwoFactor(code: string): Promise<TwoFactorCodes> {
  return apiRequest("/two-factor/enable", { method: "POST", body: { code } });
}

/** A current code, a recovery code or the password; 401 when it is wrong. */
export function disableTwoFactor(proof: TwoFactorProof): Promise<TwoFactorStatus> {
  return apiRequest("/two-factor/disable", { method: "POST", body: proof });
}

/** A current code; the old recovery codes stop working. */
export function replaceRecoveryCodes(code: string): Promise<TwoFactorCodes> {
  return apiRequest("/two-factor/recovery-codes", { method: "POST", body: { code } });
}
