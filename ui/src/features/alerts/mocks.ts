import { type HttpHandler, HttpResponse, http } from "msw";
import type {
  AlertChannel,
  AlertChannelInput,
  AlertDelivery,
  AlertsConfig,
  AlertsUpdate,
} from "@/lib/api/alerts";
import { mockDb, mockNowUnix } from "@/lib/mocks/db";
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

function seed(): AlertsState {
  return {
    rules: {
      accountUsage: true,
      poolUsage: true,
      accountBanned: true,
      allUnavailable: true,
      accountThresholds: [80, 90, 100],
      poolThresholds: [80, 90, 100],
      poolCooldownMinutes: 60,
    },
    channels: [],
  };
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
        input.type === "webhook" ? (input.secret ?? "").trim() || (keep ? prev.secret : "") : "",
      lastResult: prev?.lastResult ?? null,
    };
    if (channel.type === "telegram") {
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(channel.botToken)) return channelError(index, "botToken");
      if (!channel.chatId) return channelError(index, "chatId");
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
];
