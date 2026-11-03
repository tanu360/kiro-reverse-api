export type ProxyType = "none" | "socks5" | "http";
export type ProxyScheme = "socks5" | "socks5h" | "http" | "https";

/** The outbound proxy form, split from and joined back into `proxyURL`. */
export interface ProxyModel {
  type: ProxyType;
  /** Kept through a round trip, so socks5h and https are not lost. */
  scheme: ProxyScheme;
  /** Without IPv6 brackets */
  host: string;
  /** Digits as typed; '' when the URL has none */
  port: string;
  /** Decoded */
  username: string;
  /** Decoded */
  password: string;
}

const SCHEMES: readonly ProxyScheme[] = ["socks5", "socks5h", "http", "https"];

export const DIRECT_PROXY: ProxyModel = {
  type: "none",
  scheme: "socks5",
  host: "",
  port: "",
  username: "",
  password: "",
};

function isScheme(value: string): value is ProxyScheme {
  return (SCHEMES as readonly string[]).includes(value);
}

function typeOfScheme(scheme: ProxyScheme): Exclude<ProxyType, "none"> {
  return scheme.startsWith("socks5") ? "socks5" : "http";
}

/** The scheme to use for `type`: the current one when it fits, else the type's plain scheme. */
export function schemeForType(type: Exclude<ProxyType, "none">, current: ProxyScheme): ProxyScheme {
  return typeOfScheme(current) === type ? current : type;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Splits a proxy URL by hand: `new URL` drops default ports, rewrites hosts and cannot keep
 * the raw credentials. Anything that is not one of the four accepted schemes reads as direct.
 */
export function parseProxyUrl(url: string): ProxyModel {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url.trim());
  if (!match) return { ...DIRECT_PROXY };
  const scheme = match[1].toLowerCase();
  if (!isScheme(scheme)) return { ...DIRECT_PROXY };

  const authority = match[2].split(/[/?#]/, 1)[0] ?? "";
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0 ? authority.slice(0, at) : "";
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;

  const colon = userinfo.indexOf(":");
  const username = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
  const password = colon >= 0 ? userinfo.slice(colon + 1) : "";

  let host = hostPort;
  let port = "";
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    host = close >= 0 ? hostPort.slice(1, close) : hostPort.slice(1);
    const rest = close >= 0 ? hostPort.slice(close + 1) : "";
    if (rest.startsWith(":")) port = rest.slice(1);
  } else {
    const portColon = hostPort.lastIndexOf(":");
    if (portColon >= 0) {
      host = hostPort.slice(0, portColon);
      port = hostPort.slice(portColon + 1);
    }
  }

  return {
    type: typeOfScheme(scheme),
    scheme,
    host,
    port,
    username: decode(username),
    password: decode(password),
  };
}

/**
 * Joins the form back into a URL: `scheme://[user[:pass]@]host:port`, credentials encoded,
 * IPv6 hosts bracketed. A password without a username is dropped. Direct gives ''.
 */
export function buildProxyUrl(model: ProxyModel): string {
  if (model.type === "none") return "";
  const scheme = schemeForType(model.type, model.scheme);
  const username = model.username.trim();
  const password = model.password.trim();
  let auth = "";
  if (username) {
    auth = password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : `${encodeURIComponent(username)}@`;
  }
  const rawHost = model.host.trim();
  const host = rawHost.includes(":") && !rawHost.startsWith("[") ? `[${rawHost}]` : rawHost;
  return `${scheme}://${auth}${host}:${model.port.trim()}`;
}
