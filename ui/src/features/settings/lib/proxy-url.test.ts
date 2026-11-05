import { describe, expect, it } from "vitest";
import { buildProxyUrl, parseProxyUrl } from "./proxy-url";

describe("parseProxyUrl", () => {
  it("keeps socks5h and decodes the credentials", () => {
    const model = parseProxyUrl("socks5h://u%40x:p%3Ass@host:1080");
    expect(model).toEqual({
      type: "socks5",
      scheme: "socks5h",
      host: "host",
      port: "1080",
      username: "u@x",
      password: "p:ss",
    });
    expect(buildProxyUrl(model)).toBe("socks5h://u%40x:p%3Ass@host:1080");
  });

  it("unbrackets an IPv6 host, keeps https and brackets it again on build", () => {
    const model = parseProxyUrl("https://[::1]:8443");
    expect(model).toMatchObject({ type: "http", scheme: "https", host: "::1", port: "8443" });
    expect(buildProxyUrl(model)).toBe("https://[::1]:8443");
  });

  it("treats an empty value as direct", () => {
    expect(parseProxyUrl("")).toMatchObject({ type: "none", host: "", port: "" });
    expect(parseProxyUrl("   ").type).toBe("none");
  });

  it("gives an empty port for a port-less URL", () => {
    expect(parseProxyUrl("http://proxy.local")).toMatchObject({
      type: "http",
      scheme: "http",
      host: "proxy.local",
      port: "",
    });
  });

  it("treats an unknown scheme as direct", () => {
    expect(parseProxyUrl("ftp://host:21").type).toBe("none");
    expect(parseProxyUrl("host:1080").type).toBe("none");
  });

  it("keeps credentials that are not valid percent-encoding as typed", () => {
    expect(parseProxyUrl("socks5://a%zz:b@h:1").username).toBe("a%zz");
  });
});

describe("buildProxyUrl", () => {
  const base = {
    type: "socks5" as const,
    scheme: "socks5" as const,
    host: "127.0.0.1",
    port: "1080",
    username: "",
    password: "",
  };

  it("gives an empty string for direct", () => {
    expect(buildProxyUrl({ ...base, type: "none" })).toBe("");
  });

  it("writes user@ when there is a username but no password", () => {
    expect(buildProxyUrl({ ...base, username: "user" })).toBe("socks5://user@127.0.0.1:1080");
  });

  it("ignores a password without a username", () => {
    expect(buildProxyUrl({ ...base, password: "secret" })).toBe("socks5://127.0.0.1:1080");
  });

  it("encodes both credentials", () => {
    expect(buildProxyUrl({ ...base, username: "a b", password: "p@ss/1" })).toBe(
      "socks5://a%20b:p%40ss%2F1@127.0.0.1:1080",
    );
  });

  it("uses the type's default scheme when the scheme belongs to the other type", () => {
    expect(buildProxyUrl({ ...base, type: "http", scheme: "socks5h" })).toBe(
      "http://127.0.0.1:1080",
    );
    expect(buildProxyUrl({ ...base, type: "socks5", scheme: "https" })).toBe(
      "socks5://127.0.0.1:1080",
    );
  });

  it("keeps https for the HTTP type", () => {
    expect(buildProxyUrl({ ...base, type: "http", scheme: "https" })).toBe(
      "https://127.0.0.1:1080",
    );
  });

  it("does not bracket an already bracketed IPv6 host twice", () => {
    expect(buildProxyUrl({ ...base, host: "[fe80::1]" })).toBe("socks5://[fe80::1]:1080");
  });
});
