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
  /** account_usage | pool_usage | account_banned | all_unavailable | daily_summary | test */
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
  /** The daily usage summary; off until switched on. */
  dailySummary: boolean;
  /** When it goes out, in minutes after midnight UTC (0..1439); 540 (09:00 UTC) by default. */
  dailySummaryMinute: number;
  /** When the last scheduled summary went out (unix s); 0 for never. */
  dailySummaryLastSent: number;
}

/**
 * A channel in a POST. With the `id` of a saved channel of the same type, a blank `url`,
 * `botToken` or `secret` keeps the saved value, and `clearSecret` removes the saved signing
 * secret instead; without an id (or with an unknown one) the channel is created.
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
  clearSecret?: boolean;
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
  dailySummary?: boolean;
  /** minutes after midnight UTC, 0..1439 */
  dailySummaryMinute?: number;
}

/** The codes a 400 from POST /alerts carries; `field` (and `index` for a channel) say where. */
export type AlertsErrorCode =
  | "alert_thresholds_invalid"
  | "alert_cooldown_range"
  | "alert_channel_invalid"
  | "alert_channel_limit"
  | "alert_summary_time_range";

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

/** One channel's result of a summary test send. */
export interface DailySummaryTestResult extends AlertDelivery {
  channelId: string;
}

export interface DailySummaryTestResponse {
  /** One per enabled channel, in channel order. */
  results: DailySummaryTestResult[];
  title: string;
  /** The summary as the chat channels get it. */
  text: string;
}

/**
 * The summary of the last 24 hours, sent now to every enabled channel with one attempt each. It
 * does not count as the day's summary. 409 `alert_no_channels` when no channel is on.
 */
export function testDailySummary(): Promise<DailySummaryTestResponse> {
  return apiRequest("/alerts/daily-summary/test", { method: "POST" });
}
