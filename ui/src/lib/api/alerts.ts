import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";

/*
 * GET/POST /alerts and POST /alerts/test. The types live here rather than in types.ts: nothing
 * else uses them.
 */

export type AlertChannelType = "webhook" | "telegram" | "discord" | "slack";

export const ALERT_CHANNEL_TYPES: readonly AlertChannelType[] = [
  "webhook",
  "telegram",
  "discord",
  "slack",
];

/** A channel's last send: `error` is scrubbed of the channel's URL, token and secret. */
export interface AlertDelivery {
  /** Unix seconds */
  ts: number;
  ok: boolean;
  /** Last HTTP status; 0 when no response came back */
  status: number;
  attempts: number;
  /** account_usage | pool_usage | account_banned | all_unavailable | test */
  event: string;
  error?: string;
}

/**
 * A channel as GET returns it: never the URL, bot token or signing secret, only whether each is
 * set and `targetHint` (`https://host/…`, or `bot <id>` for Telegram).
 */
export interface AlertChannel {
  id: string;
  type: AlertChannelType;
  name: string;
  enabled: boolean;
  /** Telegram only */
  chatId?: string;
  targetHint: string;
  urlSet: boolean;
  botTokenSet: boolean;
  secretSet: boolean;
  lastResult: AlertDelivery | null;
}

export interface AlertsConfig {
  accountUsage: boolean;
  poolUsage: boolean;
  accountBanned: boolean;
  allUnavailable: boolean;
  accountThresholds: number[];
  poolThresholds: number[];
  poolCooldownMinutes: number;
  channels: AlertChannel[];
}

/**
 * A channel in a POST. With the `id` of a saved channel of the same type, a blank `url`,
 * `botToken` or `secret` keeps the saved value; without an id (or with an unknown one) the
 * channel is created.
 */
export interface AlertChannelInput {
  id?: string;
  type: AlertChannelType;
  name: string;
  enabled: boolean;
  url?: string;
  botToken?: string;
  chatId?: string;
  secret?: string;
}

/** Patch semantics; `channels`, when sent, is the whole new list (a missing channel is deleted). */
export interface AlertsUpdate {
  accountUsage?: boolean;
  poolUsage?: boolean;
  accountBanned?: boolean;
  allUnavailable?: boolean;
  accountThresholds?: number[];
  poolThresholds?: number[];
  poolCooldownMinutes?: number;
  channels?: AlertChannelInput[];
}

/** The codes a 400 from POST /alerts carries; `field` (and `index` for a channel) say where. */
export type AlertsErrorCode =
  | "alert_thresholds_invalid"
  | "alert_cooldown_range"
  | "alert_channel_invalid"
  | "alert_channel_limit";

/** Under ["settings"], so a settings_changed event refetches it. */
export const alertsQueryKey = ["settings", "alerts"] as const;

async function getAlerts(): Promise<AlertsConfig> {
  const res = await apiRequest<AlertsConfig>("/alerts");
  return { ...res, channels: res.channels ?? [] };
}

export function alertsQuery() {
  return queryOptions({ queryKey: alertsQueryKey, queryFn: getAlerts });
}

/** Answers with the saved config, as GET does. */
export async function updateAlerts(patch: AlertsUpdate): Promise<AlertsConfig> {
  const res = await apiRequest<AlertsConfig>("/alerts", { method: "POST", body: patch });
  return { ...res, channels: res.channels ?? [] };
}

/** One attempt with a 10 s timeout; 404 `alert_channel_not_found` for an unknown id. */
export function testAlertChannel(channelId: string): Promise<AlertDelivery> {
  return apiRequest("/alerts/test", { method: "POST", body: { channelId } });
}
