import type { TFunction } from "@/lib/i18n";

/** Failure kinds the server names, each with its own sentence. */
const FAILURE_KEYS: Record<string, string> = {
  connect: "proxy-pool:failure.connect",
  timeout: "proxy-pool:failure.timeout",
  dns: "proxy-pool:failure.dns",
  tls: "proxy-pool:failure.tls",
  auth: "proxy-pool:failure.auth",
  tunnel: "proxy-pool:failure.tunnel",
  socks: "proxy-pool:failure.socks",
};

/**
 * One short sentence for how a connection through a proxy failed, from the server's failure kind
 * and the proxy's answer to CONNECT. A refused CONNECT names its HTTP status; an unknown or
 * missing kind reads as the generic sentence.
 */
export function proxyFailureSentence(
  code: string | undefined,
  status: number | undefined,
  t: TFunction,
): string {
  if (code === "tunnel" && status) return t("proxy-pool:failure.tunnelStatus", { status });
  const key = code ? FAILURE_KEYS[code] : undefined;
  return t(key ?? "proxy-pool:failure.unknown");
}
