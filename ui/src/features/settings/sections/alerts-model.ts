import type {
  AlertChannel,
  AlertChannelInput,
  AlertChannelType,
  AlertsConfig,
} from "@/lib/api/alerts";

/** The server's rules for a threshold list (config.ValidateAlertThresholds). */
export const MAX_THRESHOLDS = 10;
export const COOLDOWN_MIN = 1;
export const COOLDOWN_MAX = 1440;
export const MAX_CHANNELS = 20;
export const NAME_MAX = 64;
/** The server's caps on a channel's fields (proxy/alerts_api.go), in UTF-8 bytes. */
export const URL_MAX = 2048;
export const SECRET_MAX = 256;
export const CHAT_ID_MAX = 64;

export type ThresholdParse = { ok: true; values: number[] } | { ok: false };

/**
 * "80, 90 100" → [80, 90, 100]: 1 to 10 whole percentages from 1 to 100, strictly ascending,
 * separated by commas or spaces. Not sorted for the user: an out-of-order list is rejected, as
 * the server rejects it.
 */
export function parseThresholds(text: string): ThresholdParse {
  const parts = text
    .trim()
    .split(/[\s,，、;]+/)
    .filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_THRESHOLDS) return { ok: false };
  const values: number[] = [];
  for (const part of parts) {
    const cleaned = part.replace(/%$/, "");
    if (!/^\d{1,3}$/.test(cleaned)) return { ok: false };
    const value = Number(cleaned);
    if (value < 1 || value > 100) return { ok: false };
    const previous = values[values.length - 1];
    if (previous !== undefined && value <= previous) return { ok: false };
    values.push(value);
  }
  return { ok: true, values };
}

export function formatThresholds(values: readonly number[]): string {
  return values.join(", ");
}

/** The rule fields the card edits; the thresholds as typed. */
export interface RulesForm {
  accountUsage: boolean;
  poolUsage: boolean;
  accountBanned: boolean;
  allUnavailable: boolean;
  accountThresholds: string;
  poolThresholds: string;
  poolCooldownMinutes: number | null;
}

export function rulesForm(config: AlertsConfig): RulesForm {
  return {
    accountUsage: config.accountUsage,
    poolUsage: config.poolUsage,
    accountBanned: config.accountBanned,
    allUnavailable: config.allUnavailable,
    accountThresholds: formatThresholds(config.accountThresholds ?? []),
    poolThresholds: formatThresholds(config.poolThresholds ?? []),
    poolCooldownMinutes: config.poolCooldownMinutes,
  };
}

export type RulesField = "accountThresholds" | "poolThresholds" | "poolCooldownMinutes";

export function validCooldown(value: number | null): value is number {
  return (
    value !== null && Number.isInteger(value) && value >= COOLDOWN_MIN && value <= COOLDOWN_MAX
  );
}

/** The fields that fail the server's rules, in form order. */
export function invalidRulesFields(form: RulesForm): RulesField[] {
  const invalid: RulesField[] = [];
  if (!parseThresholds(form.accountThresholds).ok) invalid.push("accountThresholds");
  if (!parseThresholds(form.poolThresholds).ok) invalid.push("poolThresholds");
  if (!validCooldown(form.poolCooldownMinutes)) invalid.push("poolCooldownMinutes");
  return invalid;
}

/**
 * A channel being added or edited. Secrets start blank: the server never sends them.
 * `clearSecret` removes the saved signing secret, which a blank `secret` would keep.
 */
export interface ChannelDraft {
  id?: string;
  type: AlertChannelType;
  name: string;
  enabled: boolean;
  url: string;
  botToken: string;
  chatId: string;
  secret: string;
  clearSecret: boolean;
}

export function newChannelDraft(type: AlertChannelType = "webhook"): ChannelDraft {
  return {
    type,
    name: "",
    enabled: true,
    url: "",
    botToken: "",
    chatId: "",
    secret: "",
    clearSecret: false,
  };
}

export function channelDraft(channel: AlertChannel): ChannelDraft {
  return {
    id: channel.id,
    type: channel.type,
    name: channel.name,
    enabled: channel.enabled,
    url: "",
    botToken: "",
    chatId: channel.chatId ?? "",
    secret: "",
    clearSecret: false,
  };
}

export type ChannelField = "name" | "url" | "botToken" | "chatId" | "secret";
export type ChannelProblem =
  | "required"
  | "urlInvalid"
  | "urlTooLong"
  | "nameTooLong"
  | "botTokenInvalid"
  | "chatIdInvalid"
  | "secretTooLong";
export type ChannelErrors = Partial<Record<ChannelField, ChannelProblem>>;

const TELEGRAM_TOKEN = /^\d+:[A-Za-z0-9_-]+$/;
const WHITESPACE = /[ \t\r\n]/;

/** The server counts these caps in UTF-8 bytes, not characters. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "";
  } catch {
    return false;
  }
}

/**
 * What stops a draft from saving. `saved` is the channel being edited: a blank secret is fine
 * while the saved channel has one of the same type, since the server keeps it.
 */
export function validateChannelDraft(draft: ChannelDraft, saved?: AlertChannel): ChannelErrors {
  const errors: ChannelErrors = {};
  const sameType = saved !== undefined && saved.type === draft.type;
  if (draft.name.trim().length > NAME_MAX) errors.name = "nameTooLong";
  if (draft.type === "telegram") {
    const token = draft.botToken.trim();
    if (!token && !(sameType && saved.botTokenSet)) errors.botToken = "required";
    else if (token && (byteLength(token) > SECRET_MAX || !TELEGRAM_TOKEN.test(token))) {
      errors.botToken = "botTokenInvalid";
    }
    const chatId = draft.chatId.trim();
    if (!chatId) errors.chatId = "required";
    else if (byteLength(chatId) > CHAT_ID_MAX || WHITESPACE.test(chatId)) {
      errors.chatId = "chatIdInvalid";
    }
  } else {
    const url = draft.url.trim();
    if (!url && !(sameType && saved.urlSet)) errors.url = "required";
    else if (url && byteLength(url) > URL_MAX) errors.url = "urlTooLong";
    else if (url && !isHttpUrl(url)) errors.url = "urlInvalid";
    if (draft.type === "webhook" && byteLength(draft.secret.trim()) > SECRET_MAX) {
      errors.secret = "secretTooLong";
    }
  }
  return errors;
}

/** What each field's own rule is called, for a server error the checks above did not catch. */
const FIELD_PROBLEM: Record<ChannelField, ChannelProblem> = {
  name: "nameTooLong",
  url: "urlInvalid",
  botToken: "botTokenInvalid",
  chatId: "chatIdInvalid",
  secret: "secretTooLong",
};

/**
 * The problem to show for a field the server rejected: "required" when the field is blank (the
 * saved value it relied on is gone), else that field's own rule, never "required" under a field
 * that is filled in.
 */
export function serverChannelProblem(field: ChannelField, draft: ChannelDraft): ChannelProblem {
  return validateChannelDraft(draft)[field] ?? FIELD_PROBLEM[field];
}

/** The saved channels as a POST sends them back: secrets blank, so the server keeps them. */
export function toChannelInputs(channels: readonly AlertChannel[]): AlertChannelInput[] {
  return channels.map((channel) => ({
    id: channel.id,
    type: channel.type,
    name: channel.name,
    enabled: channel.enabled,
    ...(channel.type === "telegram" ? { chatId: channel.chatId ?? "" } : {}),
  }));
}

/** A draft as a POST sends it: only its type's fields, trimmed; a blank secret is left out. */
export function draftInput(draft: ChannelDraft): AlertChannelInput {
  const input: AlertChannelInput = {
    ...(draft.id ? { id: draft.id } : {}),
    type: draft.type,
    name: draft.name.trim(),
    enabled: draft.enabled,
  };
  if (draft.type === "telegram") {
    if (draft.botToken.trim()) input.botToken = draft.botToken.trim();
    input.chatId = draft.chatId.trim();
  } else {
    if (draft.url.trim()) input.url = draft.url.trim();
    if (draft.type === "webhook") {
      if (draft.secret.trim()) input.secret = draft.secret.trim();
      else if (draft.clearSecret) input.clearSecret = true;
    }
  }
  return input;
}

/** The channel list with the draft put in place of its saved channel, or added at the end. */
export function withDraft(
  channels: readonly AlertChannel[],
  draft: ChannelDraft,
): { inputs: AlertChannelInput[]; index: number } {
  const inputs = toChannelInputs(channels);
  const at = draft.id ? channels.findIndex((channel) => channel.id === draft.id) : -1;
  if (at < 0) return { inputs: [...inputs, draftInput(draft)], index: inputs.length };
  inputs[at] = draftInput(draft);
  return { inputs, index: at };
}
