import { describe, expect, it } from "vitest";
import { type TFunction, translate } from "@/lib/i18n";
import en from "@/locales/errors/en.json";
import zh from "@/locales/errors/zh.json";
import { ApiError } from "./errors";
import { errorMessage, SERVER_ERROR_KEYS, serverErrorKey } from "./server-errors";

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
    for (const key of Object.values(SERVER_ERROR_KEYS)) {
      expect(key).toMatch(/^errors:serverError\.[a-zA-Z]+$/);
      const name = key.slice("errors:".length);
      expect(en, name).toHaveProperty([name]);
      expect(zh, name).toHaveProperty([name]);
    }
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
      "Too many attempts. Try again in 30 s.",
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
    const error = new ApiError({ status: 500, serverMessage: "注册客户端失败: timeout" });
    expect(errorMessage(error, t)).toBe("注册客户端失败: timeout");
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
