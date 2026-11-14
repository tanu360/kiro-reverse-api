import { type HttpHandler, HttpResponse, http } from "msw";
import type {
  AlertChannel,
  AlertChannelInput,
  AlertDelivery,
  AlertsConfig,
  AlertsUpdate,
  DailySummaryTestResponse,
} from "@/lib/api/alerts";
import { mockDb, mockNowUnix, mockScenario } from "@/lib/mocks/db";
import { publishMockEvent } from "@/lib/mocks/events";
import { apiUrl, jsonError, mockDelay, requireAuth } from "@/lib/mocks/http";

/** What the server stores for a channel: the view plus the secrets it never returns. */
interface StoredChannel
  extends Omit<AlertChannel, "targetHint" | "urlSet" | "botTokenSet" | "secretSet"> {
  url: string;
  botToken: string;
  secret: string;
}

interface AlertsState {
  rules: Omit<AlertsConfig, "channels">;
  channels: StoredChannel[];
}

const DAY = 86_400;

/** The latest summary slot at or before now (unix s), minute after midnight UTC. */
function lastSlot(now: number, minute: number): number {
  const slot = Math.floor(now / DAY) * DAY + minute * 60;
  return slot > now ? slot - DAY : slot;
}

function seed(): AlertsState {
  const rules: AlertsState["rules"] = {
    accountUsage: true,
    poolUsage: true,
    accountBanned: true,
    allUnavailable: true,
    accountThresholds: [80, 90, 100],
    poolThresholds: [80, 90, 100],
    poolCooldownMinutes: 60,
    dailySummary: false,
    dailySummaryMinute: 9 * 60,
    dailySummaryLastSent: 0,
  };
  if (mockScenario() !== "full") return { rules, channels: [] };
  // The full dataset: two channels and the daily summary on at 07:00 UTC, sent at its last slot.
  const now = mockNowUnix();
  const sent = lastSlot(now, 7 * 60) + 2;
  return {
    rules: { ...rules, dailySummary: true, dailySummaryMinute: 7 * 60, dailySummaryLastSent: sent },
    channels: [
      {
        id: "ch_mock_slack",
        type: "slack",
        name: "Ops channel",
        enabled: true,
        url: "https://hooks.slack.com/services/T000/B000/mock",
        botToken: "",
        chatId: "",
        secret: "",
        lastResult: { ts: sent, ok: true, status: 200, attempts: 1, event: "daily_summary" },
      },
      {
        id: "ch_mock_telegram",
        type: "telegram",
        name: "On-call phone",
        enabled: true,
        url: "",
        botToken: "7012345678:mock-token",
        chatId: "-1002003004005",
        secret: "",
        lastResult: { ts: sent, ok: true, status: 200, attempts: 1, event: "daily_summary" },
      },
    ],
  };
}

/** The summary of the last 24 hours as the chat channels get it, from the mock request log. */
function summaryText(now: number): string {
  const from = now - DAY;
  const rows = mockDb.requests.filter((r) => r.ts >= from && r.ts < now);
  const failed = rows.filter((r) => !r.success).length;
  const credits = rows.reduce((sum, r) => sum + r.credits, 0);
  const inTokens = rows.reduce((sum, r) => sum + r.inTokens, 0);
  const outTokens = rows.reduce((sum, r) => sum + r.outTokens, 0);
  const iso = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
  const pct = rows.length > 0 ? ` (${((failed / rows.length) * 100).toFixed(1)}%)` : "";
  return [
    `Last 24 hours, ${iso(from)} to ${iso(now)} UTC.`,
    `Requests: ${rows.length.toLocaleString("en-US")}, ${failed} failed${pct}`,
    `Credits used: ${credits.toFixed(2)}`,
    `Tokens: ${inTokens.toLocaleString("en-US")} in, ${outTokens.toLocaleString("en-US")} out`,
  ].join("\n");
}

// The alerts state lives beside mockDb, not in it. resetMockDb replaces mockDb.settings with a
// fresh object, so keying on it gives every reset (each unit test) a fresh alerts state too.
const states = new WeakMap<object, AlertsState>();
function state(): AlertsState {
  let current = states.get(mockDb.settings);
  if (!current) {
    current = seed();
    states.set(mockDb.settings, current);
  }
  return current;
}

let nextId = 1;

function targetHint(channel: StoredChannel): string {
  if (channel.type === "telegram") {
    const [id] = channel.botToken.split(":");
    return id && /^\d+$/.test(id) ? `bot ${id}` : "";
  }
  try {
    const url = new URL(channel.url);
    return `${url.protocol}//${url.host}/…`;
  } catch {
    return "";
  }
}

function view(): AlertsConfig {
  const current = state();
  return {
    ...current.rules,
    channels: current.channels.map((channel) => ({
      id: channel.id,
      type: channel.type,
      name: channel.name,
      enabled: channel.enabled,
      ...(channel.type === "telegram" ? { chatId: channel.chatId } : {}),
      targetHint: targetHint(channel),
      urlSet: channel.url !== "",
      botTokenSet: channel.botToken !== "",
      secretSet: channel.secret !== "",
      lastResult: channel.lastResult,
    })),
  };
}

function validThresholds(values: unknown): boolean {
  return (
    Array.isArray(values) &&
    values.length >= 1 &&
    values.length <= 10 &&
    values.every(
      (value, i) =>
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 100 &&
        (i === 0 || value > (values[i - 1] as number)),
    )
  );
}

function channelError(index: number, field: string): Response {
  return jsonError(400, `invalid ${field}`, { code: "alert_channel_invalid", field, index });
}

/** Go's MergeAlertChannels plus the checks of normalizeAlertChannels. */
function mergeChannels(inputs: AlertChannelInput[]): StoredChannel[] | Response {
  const stored = new Map(state().channels.map((channel) => [channel.id, channel]));
  const out: StoredChannel[] = [];
  for (const [index, input] of inputs.entries()) {
    if (!["webhook", "telegram", "discord", "slack"].includes(input.type)) {
      return channelError(index, "type");
    }
    const name = (input.name ?? "").trim();
    if (name.length > 64) return channelError(index, "name");
    const prev = input.id ? stored.get(input.id) : undefined;
    const keep = prev !== undefined && prev.type === input.type;
    const channel: StoredChannel = {
      id: prev ? prev.id : `ch_mock${nextId++}`,
      type: input.type,
      name,
      enabled: input.enabled !== false,
      url: input.type === "telegram" ? "" : (input.url ?? "").trim() || (keep ? prev.url : ""),
      botToken:
        input.type === "telegram"
          ? (input.botToken ?? "").trim() || (keep ? prev.botToken : "")
          : "",
      chatId: input.type === "telegram" ? (input.chatId ?? "").trim() : "",
      secret:
        input.type === "webhook"
          ? (input.secret ?? "").trim() || (keep && !input.clearSecret ? prev.secret : "")
          : "",
      lastResult: prev?.lastResult ?? null,
    };
    if (channel.type === "telegram") {
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(channel.botToken)) return channelError(index, "botToken");
      if (!channel.chatId || /\s/.test(channel.chatId)) return channelError(index, "chatId");
    } else if (!/^https?:\/\/[^/]+/.test(channel.url)) {
      return channelError(index, "url");
    }
    out.push(channel);
  }
  return out;
}

export const handlers: HttpHandler[] = [
  http.get(apiUrl("/alerts"), async ({ request }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    return HttpResponse.json(view());
  }),

  http.post(apiUrl("/alerts"), async ({ request }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    const body = (await request.json().catch(() => null)) as AlertsUpdate | null;
    if (!body || typeof body !== "object") {
      return jsonError(400, "Invalid JSON", { code: "invalid_json" });
    }
    for (const field of ["accountThresholds", "poolThresholds"] as const) {
      if (body[field] !== undefined && !validThresholds(body[field])) {
        return jsonError(400, "thresholds must be strictly ascending", {
          code: "alert_thresholds_invalid",
          field,
        });
      }
    }
    const minute = body.dailySummaryMinute;
    if (minute !== undefined && !(Number.isInteger(minute) && minute >= 0 && minute <= 1439)) {
      return jsonError(400, "dailySummaryMinute must be 0 to 1439 (minutes after midnight UTC)", {
        code: "alert_summary_time_range",
        field: "dailySummaryMinute",
        min: 0,
        max: 1439,
      });
    }
    const cooldown = body.poolCooldownMinutes;
    if (
      cooldown !== undefined &&
      !(Number.isInteger(cooldown) && cooldown >= 1 && cooldown <= 1440)
    ) {
      return jsonError(400, "poolCooldownMinutes must be 1 to 1440", {
        code: "alert_cooldown_range",
        field: "poolCooldownMinutes",
        min: 1,
        max: 1440,
      });
    }
    let channels: StoredChannel[] | undefined;
    if (body.channels !== undefined) {
      if (body.channels.length > 20) {
        return jsonError(400, "At most 20 alert channels", {
          code: "alert_channel_limit",
          max: 20,
        });
      }
      const merged = mergeChannels(body.channels);
      if (merged instanceof Response) return merged;
      channels = merged;
    }
    const current = state();
    const { channels: _ignored, ...rules } = body;
    current.rules = { ...current.rules, ...rules };
    if (channels) current.channels = channels;
    publishMockEvent("settings_changed", "alerts");
    return HttpResponse.json(view());
  }),

  http.post(apiUrl("/alerts/test"), async ({ request }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    const body = (await request.json().catch(() => null)) as { channelId?: string } | null;
    const channel = state().channels.find((item) => item.id === body?.channelId);
    if (!channel) {
      return jsonError(404, "Alert channel not found", { code: "alert_channel_not_found" });
    }
    // A URL with "fail" in it plays a channel that answers 404, to show a failed result.
    const fails = channel.url.includes("fail");
    const result: AlertDelivery = fails
      ? {
          ts: mockNowUnix(),
          ok: false,
          status: 404,
          attempts: 1,
          event: "test",
          error: "HTTP 404: unknown webhook",
        }
      : { ts: mockNowUnix(), ok: true, status: 200, attempts: 1, event: "test" };
    channel.lastResult = result;
    return HttpResponse.json(result);
  }),

  http.post(apiUrl("/alerts/daily-summary/test"), async ({ request }) => {
    await mockDelay();
    const denied = requireAuth(request);
    if (denied) return denied;
    const channels = state().channels.filter((channel) => channel.enabled);
    if (channels.length === 0) {
      return jsonError(409, "Add or switch on an alert channel first", {
        code: "alert_no_channels",
      });
    }
    const now = mockNowUnix();
    const results = channels.map((channel) => {
      // A URL with "fail" in it plays a channel that answers 404, as the per-channel test does.
      const result: AlertDelivery = channel.url.includes("fail")
        ? {
            ts: now,
            ok: false,
            status: 404,
            attempts: 1,
            event: "daily_summary",
            error: "HTTP 404: unknown webhook",
          }
        : { ts: now, ok: true, status: 200, attempts: 1, event: "daily_summary" };
      channel.lastResult = result;
      return { channelId: channel.id, ...result };
    });
    publishMockEvent("settings_changed", "alerts");
    const body: DailySummaryTestResponse = {
      results,
      title: "Daily usage summary",
      text: summaryText(now),
    };
    return HttpResponse.json(body);
  }),
];
