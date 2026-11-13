import { describe, expect, it } from "vitest";
import {
  buildProxyUrl,
  isValidProxyPort,
  isValidProxyUrl,
  parseProxyUrl,
  proxyHostProblem,
} from "./proxy-url";

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

describe("proxyHostProblem", () => {
  it("needs a host", () => {
    expect(proxyHostProblem("")).toBe("missing");
    expect(proxyHostProblem("   ")).toBe("missing");
  });

  it("refuses a port typed after the host, as the server does", () => {
    expect(proxyHostProblem("1.2.3.4:8080")).toBe("port");
    expect(proxyHostProblem("proxy.local:1080")).toBe("port");
    expect(proxyHostProblem("1.2.3.4:8080:9")).toBe("port");
  });

  it("refuses a space, a slash, a query, an @, a % or brackets", () => {
    expect(proxyHostProblem("exa mple.com")).toBe("invalid");
    expect(proxyHostProblem("exa%mple.com")).toBe("invalid");
    expect(proxyHostProblem("user@proxy.local")).toBe("invalid");
    expect(proxyHostProblem("proxy.local/path")).toBe("invalid");
    expect(proxyHostProblem("proxy.local?x")).toBe("invalid");
    expect(proxyHostProblem("[::1]")).toBe("invalid");
  });

  it("keeps the colons of an IPv6 address", () => {
    expect(proxyHostProblem("::1")).toBeNull();
    expect(proxyHostProblem("fe80::1%eth0")).toBeNull();
    expect(proxyHostProblem("2001:db8::8a2e:370:7334")).toBeNull();
    expect(proxyHostProblem(" proxy.example.com ")).toBeNull();
  });

  it("agrees with the URL check on what the dialog builds", () => {
    for (const host of ["1.2.3.4:8080", "exa mple.com", "proxy.local/path", ""]) {
      const url = buildProxyUrl({ ...parseProxyUrl("socks5://h:1"), host, port: "9" });
      expect(isValidProxyUrl(url), host).toBe(false);
    }
    for (const host of ["proxy.example.com", "10.0.0.1", "::1"]) {
      const url = buildProxyUrl({ ...parseProxyUrl("socks5://h:1"), host, port: "9" });
      expect(isValidProxyUrl(url), host).toBe(true);
    }
  });
});

describe("isValidProxyPort", () => {
  it("takes 1 to 65535, digits only", () => {
    expect(isValidProxyPort("1")).toBe(true);
    expect(isValidProxyPort("65535")).toBe(true);
    expect(isValidProxyPort("0")).toBe(false);
    expect(isValidProxyPort("65536")).toBe(false);
    expect(isValidProxyPort("")).toBe(false);
    expect(isValidProxyPort("80a")).toBe(false);
  });
});
