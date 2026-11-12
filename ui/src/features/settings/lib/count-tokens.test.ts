import { describe, expect, it } from "vitest";
import {
  MAX_COUNT_TOKENS_URL_LENGTH,
  maskCountTokensKey,
  sameCountTokensOrigin,
  validCountTokensUrl,
} from "./count-tokens";

describe("validCountTokensUrl", () => {
  it("accepts http and https URLs with a host", () => {
    for (const url of [
      "http://127.0.0.1:8787/v1/messages/count_tokens",
      "https://api.anthropic.com/v1/messages/count_tokens",
      "HTTPS://Count.Example",
      "http://[::1]:9000/count?beta=true",
    ]) {
      expect(validCountTokensUrl(url), url).toBe(true);
    }
  });

  it("refuses what the server refuses", () => {
    for (const url of [
      "",
      "count.example/v1",
      "ftp://count.example",
      "socks5://127.0.0.1:1080",
      "https://",
      "https:///path",
      "https://user:secret@count.example",
      "https://token@count.example",
      "https://count.example/a b",
      " https://count.example",
      `https://count.example/${"a".repeat(MAX_COUNT_TOKENS_URL_LENGTH)}`,
    ]) {
      expect(validCountTokensUrl(url), url).toBe(false);
    }
  });
});

describe("maskCountTokensKey", () => {
  it("shows the last 4 of a long key only", () => {
    expect(maskCountTokensKey("")).toBe("");
    expect(maskCountTokensKey("short-key")).toBe("••••");
    expect(maskCountTokensKey("sk-ant-api03-WXYZ")).toBe("••••WXYZ");
  });
});

describe("sameCountTokensOrigin", () => {
  it("matches the same scheme, host and port, like config.SameCountTokensOrigin", () => {
    const saved = "https://count.example/v1/messages/count_tokens";
    expect(sameCountTokensOrigin(saved, "https://COUNT.example:443/v2?beta=true")).toBe(true);
    for (const moved of [
      "http://count.example/v1/messages/count_tokens",
      "https://counter.example/v1/messages/count_tokens",
      "https://count.example:8443/v1/messages/count_tokens",
      "",
      "not a url",
    ]) {
      expect(sameCountTokensOrigin(saved, moved), moved).toBe(false);
    }
    expect(sameCountTokensOrigin("", "")).toBe(false);
  });
});
