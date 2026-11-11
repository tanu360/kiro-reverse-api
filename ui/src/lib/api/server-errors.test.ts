import { describe, expect, it } from "vitest";
import { type TFunction, translate } from "@/lib/i18n";
import en from "@/locales/errors/en.json";
import ptBR from "@/locales/errors/pt-BR.json";
import vi from "@/locales/errors/vi.json";
import zh from "@/locales/errors/zh.json";
import { ApiError } from "./errors";
import {
  errorMessage,
  SERVER_ERROR_CODES,
  SERVER_ERROR_KEYS,
  SERVER_ERROR_PHRASES,
  serverCodeMessage,
  serverErrorCode,
  serverErrorKey,
  serverErrorPhrase,
  serverMessageText,
} from "./server-errors";

// Echoes the key so assertions show which translation was chosen.
const t: TFunction = (key) => `t(${key})`;

describe("serverErrorKey", () => {
  it("matches trimmed and case-insensitive", () => {
    expect(serverErrorKey("API KEY NOT FOUND ")).toBe("errors:serverError.apiKeyNotFound");
    expect(serverErrorKey("api key not found")).toBe("errors:serverError.apiKeyNotFound");
  });

  it("returns null for unknown messages", () => {
    expect(serverErrorKey("backup not found: abc")).toBeNull();
    expect(serverErrorKey("")).toBeNull();
  });

  it("maps every entry to an errors:serverError key present in both locales", () => {
    for (const [, key] of SERVER_ERROR_KEYS) {
      expect(key).toMatch(/^errors:serverError\.[a-zA-Z]+$/);
      const name = key.slice("errors:".length);
      expect(en, name).toHaveProperty([name]);
      expect(zh, name).toHaveProperty([name]);
    }
  });

  it("lists each message once (the lookup ignores case)", () => {
    const messages = SERVER_ERROR_KEYS.map(([message]) => message.toLowerCase());
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("ships the same keys in en and zh", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });
});

describe("errors namespace", () => {
  it("is loaded from src/locales/errors", () => {
    expect(translate("en", "common", "errors:network")).toBe("Could not connect to the proxy.");
    expect(translate("zh", "common", "errors:serverError.apiKeyNotFound")).toBe("未找到 API Key。");
    expect(translate("en", "errors", "rateLimited", { seconds: 30 })).toBe(
      "Too many attempts. Try again in 30s.",
    );
  });
});

describe("errorMessage", () => {
  it("returns the network message for status 0", () => {
    const error = new ApiError({ status: 0, serverMessage: "network" });
    expect(errorMessage(error, t)).toBe("t(errors:network)");
  });

  it("translates a known server message", () => {
    const error = new ApiError({ status: 400, serverMessage: "invalid region" });
    expect(errorMessage(error, t)).toBe("t(errors:serverError.invalidRegion)");
  });

  it("returns an unknown server message verbatim", () => {
    const error = new ApiError({ status: 500, serverMessage: "backup not found: abc" });
    expect(errorMessage(error, t)).toBe("backup not found: abc");
  });

  it("translates the Chinese AWS sign-in errors", () => {
    const iam = new ApiError({ status: 400, serverMessage: "无效的回调 URL" });
    expect(errorMessage(iam, t)).toBe("t(errors:serverError.invalidCallbackUrl)");
    const expired = new ApiError({ status: 400, serverMessage: "会话不存在或已过期" });
    expect(errorMessage(expired, t)).toBe("t(errors:serverError.ssoSessionExpired)");
  });

  it("finds a wrapped phrase and keeps the text after it as the detail", () => {
    const tWithParams: TFunction = (key, params) =>
      params ? `t(${key}, ${JSON.stringify(params)})` : `t(${key})`;
    const error = new ApiError({
      status: 500,
      serverMessage: "token 1: token 验证失败: 401 Unauthorized",
    });
    expect(errorMessage(error, tWithParams)).toBe(
      `t(common:text.joinSentences, ${JSON.stringify({
        first: "t(errors:serverError.ssoTokenRejected)",
        second: 't(errors:serverError.detail, {"detail":"401 Unauthorized"})',
      })})`,
    );
  });

  it("prefers the longest phrase", () => {
    expect(serverErrorPhrase("批准授权失败: boom")?.key).toBe(
      "errors:serverError.ssoTokenFlowFailed",
    );
    expect(serverErrorPhrase("授权失败: access_denied")).toEqual({
      key: "errors:serverError.ssoDenied",
      detail: "access_denied",
    });
  });

  it("translates each part of a '; '-joined SSO import error", () => {
    const error = new ApiError({
      status: 500,
      serverMessage: "授权超时; disk full",
    });
    expect(errorMessage(error, t)).toBe("t(errors:serverError.ssoTimeout) disk full");
  });

  it("shows real text in the English and Chinese UI", () => {
    const error = new ApiError({ status: 400, serverMessage: "无效的回调 URL" });
    const enT: TFunction = (key, params) => translate("en", "common", key, params);
    const zhT: TFunction = (key, params) => translate("zh", "common", key, params);
    expect(errorMessage(error, enT)).toBe(
      "The callback URL is not valid. Copy the full address again.",
    );
    expect(errorMessage(error, zhT)).toBe("回调 URL 无效，请重新复制完整地址。");
  });

  it("lists each phrase once", () => {
    const list = SERVER_ERROR_PHRASES.map(([phrase]) => phrase.toLowerCase());
    expect(new Set(list).size).toBe(list.length);
  });

  it("maps every phrase to a key present in both locales", () => {
    for (const [, key] of SERVER_ERROR_PHRASES) {
      const name = key.slice("errors:".length);
      expect(en, name).toHaveProperty([name]);
      expect(zh, name).toHaveProperty([name]);
    }
  });

  it("falls back for an empty message or a non-API error", () => {
    expect(errorMessage(new ApiError({ status: 500, serverMessage: "" }), t)).toBe(
      "t(errors:generic)",
    );
    expect(errorMessage(new Error("boom"), t, "settings:saveFailed")).toBe(
      "t(settings:saveFailed)",
    );
  });
});

describe("server error codes", () => {
  const lockout = () =>
    new ApiError({
      status: 409,
      serverMessage: "would lock out every client",
      body: { error: "would lock out every client", code: "api_key_lockout" },
    });

  it("reads the code from the JSON body", () => {
    expect(serverErrorCode(lockout())).toBe("api_key_lockout");
    expect(
      serverErrorCode(new ApiError({ status: 500, serverMessage: "x", body: "x" })),
    ).toBeNull();
    expect(serverErrorCode(new Error("boom"))).toBeNull();
  });

  it("translates api_key_lockout by its code, whatever the message says", () => {
    expect(errorMessage(lockout(), t)).toBe("t(errors:serverError.apiKeyLockout)");
    const reworded = new ApiError({
      status: 409,
      serverMessage: "no client could authenticate",
      body: { code: "api_key_lockout" },
    });
    expect(errorMessage(reworded, t)).toBe("t(errors:serverError.apiKeyLockout)");
  });

  it("shows real text in every language for each mapped code", () => {
    for (const key of Object.values(SERVER_ERROR_CODES)) {
      for (const lang of ["en", "zh", "vi", "pt-BR"] as const) {
        expect(translate(lang, "common", key), `${lang} ${key}`).not.toBe(key);
      }
    }
  });

  it("keeps an unmapped code's message", () => {
    // The schedule form marks the field for invalid_keep instead of showing a message.
    const error = new ApiError({
      status: 400,
      serverMessage: "keep must be between 1 and 200",
      body: { error: "keep must be between 1 and 200", code: "invalid_keep" },
    });
    expect(errorMessage(error, t)).toBe("keep must be between 1 and 200");
  });

  it("maps every code to an errors:serverError key present in all four locales", () => {
    const locales = { en, zh, vi, "pt-BR": ptBR } as Record<string, Record<string, string>>;
    for (const key of Object.values(SERVER_ERROR_CODES)) {
      expect(key).toMatch(/^errors:serverError\.[a-zA-Z]+$/);
      const name = key.slice("errors:".length);
      for (const [lang, dict] of Object.entries(locales))
        expect(dict, `${lang} ${name}`).toHaveProperty([name]);
    }
  });

  it("fills placeholders from the body and appends the upstream detail", () => {
    const enT: TFunction = (key, params) => translate("en", "common", key, params);
    const zhT: TFunction = (key, params) => translate("zh", "common", key, params);
    const refresh = new ApiError({
      status: 500,
      serverMessage: "Token refresh failed: HTTP 400: invalid_grant",
      body: {
        error: "Token refresh failed: HTTP 400: invalid_grant",
        code: "token_refresh_failed",
        detail: "HTTP 400: invalid_grant",
      },
    });
    expect(errorMessage(refresh, enT)).toBe(
      "Could not refresh the account's token. (Details: HTTP 400: invalid_grant)",
    );
    expect(errorMessage(refresh, zhT)).toBe(
      "无法刷新该账号的 Token。（详情：HTTP 400: invalid_grant）",
    );

    const duplicate = new ApiError({
      status: 400,
      serverMessage: 'source "gpt-5" is mapped more than once',
      body: { code: "model_mapping_duplicate", model: "gpt-5", index: 3 },
    });
    expect(errorMessage(duplicate, zhT)).toBe("gpt-5 被映射了多次。");

    const wrongAddress = new ApiError({
      status: 400,
      serverMessage: "callback URL must be http://localhost:3128/oauth/callback",
      body: {
        code: "callback_url_wrong_address",
        expected: "http://localhost:3128/oauth/callback",
      },
    });
    expect(errorMessage(wrongAddress, enT)).toBe(
      "This is not the expected callback URL. It must start with http://localhost:3128/oauth/callback.",
    );
  });

  it("translates a batch row by its code, and leaves a row without one to the caller", () => {
    const row = { id: "a", ok: false, code: "account_not_found", error: "Account not found" };
    expect(serverCodeMessage(row.code, row, t)).toBe("t(errors:serverError.accountNotFound)");
    expect(serverCodeMessage(undefined, { error: "HTTP 500" }, t)).toBeNull();
  });
});

describe("serverMessageText", () => {
  it("translates a known message without a code and keeps any other", () => {
    expect(serverMessageText("授权超时", t)).toBe("t(errors:serverError.ssoTimeout)");
    expect(serverMessageText("disk full", t)).toBe("disk full");
  });
});
