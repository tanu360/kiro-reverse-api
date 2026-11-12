import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type { SuccessResponse } from "./types";

/** The healer's runtime state (config.SelfHealState). Times are unix seconds, 0 = never. */
export interface SelfHealState {
  lastHealAt: number;
  /** Heals since the last successful request. */
  rounds: number;
  /** The round cap was reached: no heal until a request succeeds or an admin resumes. */
  halted: boolean;
  haltedAt: number;
  /** How many accounts the last heal restored. */
  lastHealed: number;
}

/** GET /admin/api/account-health */
export interface AccountHealth {
  enabled: boolean;
  /** 30 to 86400. */
  minIntervalSec: number;
  /** 0 to 100; 0 = no limit. */
  maxRounds: number;
  state: SelfHealState;
}

/**
 * POST /admin/api/account-health, a patch. 400 `self_heal_interval_range` or
 * `self_heal_rounds_range` when a value is out of range; the card checks both first.
 */
export interface AccountHealthPatch {
  enabled?: boolean;
  minIntervalSec?: number;
  maxRounds?: number;
}

export const SELF_HEAL_INTERVAL_MIN = 30;
export const SELF_HEAL_INTERVAL_MAX = 86_400;
export const SELF_HEAL_ROUNDS_MAX = 100;

/** Under settings.all, so settings_changed and a backup restore refetch it. */
export const accountHealthKey = [...queryKeys.settings.all, "account-health"] as const;

function getAccountHealth(): Promise<AccountHealth> {
  return apiRequest("/account-health");
}

export function accountHealthQuery() {
  return queryOptions({ queryKey: accountHealthKey, queryFn: getAccountHealth });
}

export function updateAccountHealth(patch: AccountHealthPatch): Promise<SuccessResponse> {
  return apiRequest("/account-health", { method: "POST", body: patch });
}

/** Lifts a halt and restarts the round count. */
export function resumeAccountHealth(): Promise<SuccessResponse> {
  return apiRequest("/account-health/resume", { method: "POST" });
}
