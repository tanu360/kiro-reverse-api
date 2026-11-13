export type ProxyType = "none" | "socks5" | "http";
export type ProxyScheme = "socks5" | "socks5h" | "http" | "https";

/** The outbound proxy form, split from and joined back into `proxyURL`. */
export interface ProxyModel {
  type: ProxyType;
  /** Kept through a round trip, so socks5h is not lost; http or https is picked in the form. */
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

const DIRECT_PROXY: ProxyModel = {
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

// ---------------------------------------------------------------------------
// Validation: the server's rules (proxypool.ValidateOutboundURL, parseProxyURL), shared by the
// outbound proxy dialog, the proxy pool editor and an account's own proxy field.
// ---------------------------------------------------------------------------

/** What is wrong with a typed proxy host: none given, a port after it, or not a host at all. */
export type ProxyHostProblem = "missing" | "port" | "invalid";

/**
 * An IPv6 address, with an optional %zone, by the URL parser's own rules (as Go's ParseIP):
 * "::1" is one, "1.2.3.4:8080:9" is a host with two ports.
 */
function isIPv6(host: string): boolean {
  const address = host.split("%", 1)[0];
  if (!/^[0-9a-f:.]+$/i.test(address) || !address.includes(":")) return false;
  try {
    new URL(`http://[${address}]/`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks a host as typed into a proxy form (an IPv6 address without brackets), as the server's
 * URL parser does: it is required, has no space, slash, ?, #, @, % or bracket, and holds no
 * port ("1.2.3.4:8080" with the port typed after it). An IPv6 address keeps its colons and zone.
 */
export function proxyHostProblem(host: string): ProxyHostProblem | null {
  const value = host.trim();
  if (value === "") return "missing";
  if (isIPv6(value)) return null;
  if (/[\s/?#@%[\]]/.test(value)) return "invalid";
  return value.includes(":") ? "port" : null;
}

/** Digits only, from 1 to 65535. */
export function isValidProxyPort(port: string): boolean {
  const value = Number(port);
  return /^\d+$/.test(port) && value >= 1 && value <= 65535;
}

const PROXY_URL_PATTERN = /^(socks5|socks5h|http|https):\/\/([^/?#]*)\/?$/i;

/**
 * Empty (no proxy of its own) or a socks5, socks5h, http or https URL with a host (checked as
 * proxyHostProblem does) and a port from 1 to 65535; http and https may leave the port out.
 * "http://", port 99999, a space, a path or a host with a second port are refused, as the
 * server refuses them.
 */
export function isValidProxyUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return true;
  if (/\s/.test(trimmed)) return false;
  const match = PROXY_URL_PATTERN.exec(trimmed);
  if (!match) return false;
  const scheme = match[1].toLowerCase();
  const authority = match[2];
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  let host: string;
  let port = "";
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) return false;
    host = hostPort.slice(1, close);
    // Brackets hold an IPv6 address; a bracketed "1.2.3.4:8080" is a host with a port.
    if (!isIPv6(host)) return false;
    const rest = hostPort.slice(close + 1);
    if (rest !== "" && !rest.startsWith(":")) return false;
    port = rest.slice(1);
  } else {
    const parts = hostPort.split(":");
    if (parts.length > 2) return false;
    host = parts[0];
    port = parts[1] ?? "";
  }
  if (proxyHostProblem(host) !== null) return false;
  if (port === "") return !scheme.startsWith("socks5");
  return isValidProxyPort(port);
}

/** The message under the Host field for each ProxyHostProblem. */
export const PROXY_HOST_PROBLEM_KEYS: Readonly<Record<ProxyHostProblem, string>> = {
  missing: "settings:proxyHostRequired",
  port: "settings:proxyHostHasPort",
  invalid: "settings:proxyHostInvalid",
};
