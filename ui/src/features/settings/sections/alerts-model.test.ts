import { describe, expect, it } from "vitest";
import type { AlertChannel } from "@/lib/api/alerts";
import {
  channelDraft,
  invalidRulesFields,
  newChannelDraft,
  parseThresholds,
  type RulesForm,
  toChannelInputs,
  validateChannelDraft,
  withDraft,
} from "./alerts-model";

function channel(overrides: Partial<AlertChannel> = {}): AlertChannel {
  return {
    id: "ch_1",
    type: "webhook",
    name: "Ops",
    enabled: true,
    targetHint: "https://hooks.example.com/…",
    urlSet: true,
    botTokenSet: false,
    secretSet: true,
    lastResult: null,
    ...overrides,
  };
}

describe("parseThresholds", () => {
  it("reads commas, spaces and a trailing percent sign", () => {
    expect(parseThresholds("80, 90 100%")).toEqual({ ok: true, values: [80, 90, 100] });
    expect(parseThresholds(" 50 ")).toEqual({ ok: true, values: [50] });
  });

  it("rejects what the server rejects", () => {
    for (const text of [
      "",
      "0",
      "101",
      "90, 80",
      "80, 80",
      "8.5",
      "abc",
      "1 2 3 4 5 6 7 8 9 10 11",
    ]) {
      expect(parseThresholds(text), text).toEqual({ ok: false });
    }
    expect(parseThresholds("1 2 3 4 5 6 7 8 9 10").ok).toBe(true);
  });
});

describe("invalidRulesFields", () => {
  const form: RulesForm = {
    accountUsage: true,
    poolUsage: true,
    accountBanned: true,
    allUnavailable: true,
    accountThresholds: "80, 90, 100",
    poolThresholds: "80, 90, 100",
    poolCooldownMinutes: 60,
  };

  it("passes a valid form and names each bad field", () => {
    expect(invalidRulesFields(form)).toEqual([]);
    expect(
      invalidRulesFields({
        ...form,
        accountThresholds: "90, 80",
        poolCooldownMinutes: 1441,
      }),
    ).toEqual(["accountThresholds", "poolCooldownMinutes"]);
    expect(invalidRulesFields({ ...form, poolCooldownMinutes: null })).toEqual([
      "poolCooldownMinutes",
    ]);
  });
});

describe("validateChannelDraft", () => {
  it("asks a new channel for its type's secrets", () => {
    expect(validateChannelDraft(newChannelDraft("webhook"))).toEqual({ url: "required" });
    expect(validateChannelDraft(newChannelDraft("telegram"))).toEqual({
      botToken: "required",
      chatId: "required",
    });
    expect(
      validateChannelDraft({ ...newChannelDraft("slack"), url: "ftp://hooks.example.com" }),
    ).toEqual({ url: "urlInvalid" });
    expect(
      validateChannelDraft({ ...newChannelDraft("telegram"), botToken: "nope", chatId: "@ops" }),
    ).toEqual({ botToken: "botTokenInvalid" });
  });

  it("lets a saved channel keep its secret with a blank field, until its type changes", () => {
    const saved = channel();
    expect(validateChannelDraft(channelDraft(saved), saved)).toEqual({});
    expect(validateChannelDraft({ ...channelDraft(saved), type: "discord" }, saved)).toEqual({
      url: "required",
    });
  });

  it("caps the name", () => {
    const draft = { ...newChannelDraft(), url: "https://example.com", name: "x".repeat(65) };
    expect(validateChannelDraft(draft)).toEqual({ name: "nameTooLong" });
  });
});

describe("channel inputs", () => {
  it("sends saved channels back with blank secrets", () => {
    const inputs = toChannelInputs([
      channel(),
      channel({ id: "ch_2", type: "telegram", chatId: "@ops", urlSet: false, botTokenSet: true }),
    ]);
    expect(inputs).toEqual([
      { id: "ch_1", type: "webhook", name: "Ops", enabled: true },
      { id: "ch_2", type: "telegram", name: "Ops", enabled: true, chatId: "@ops" },
    ]);
  });

  it("puts an edited draft in place and adds a new one at the end", () => {
    const saved = [channel(), channel({ id: "ch_2", name: "Second" })];
    const edited = withDraft(saved, {
      ...channelDraft(saved[1] as AlertChannel),
      name: " Renamed ",
    });
    expect(edited.index).toBe(1);
    expect(edited.inputs[1]).toEqual({
      id: "ch_2",
      type: "webhook",
      name: "Renamed",
      enabled: true,
    });

    const added = withDraft(saved, {
      ...newChannelDraft("webhook"),
      url: " https://hooks.example.com/a ",
      secret: "s3cret",
    });
    expect(added.index).toBe(2);
    expect(added.inputs[2]).toEqual({
      type: "webhook",
      name: "",
      enabled: true,
      url: "https://hooks.example.com/a",
      secret: "s3cret",
    });
  });

  it("leaves out the fields of other types", () => {
    const { inputs } = withDraft([], {
      ...newChannelDraft("telegram"),
      url: "https://ignored.example.com",
      secret: "ignored",
      botToken: "123:abc",
      chatId: "42",
    });
    expect(inputs).toEqual([
      { type: "telegram", name: "", enabled: true, botToken: "123:abc", chatId: "42" },
    ]);
  });
});
