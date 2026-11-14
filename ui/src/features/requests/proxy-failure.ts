import { proxyFailureSentence } from "@/features/proxy-pool/lib/pool-failure";
import type { RequestAttemptProxy, RequestRecord } from "@/lib/api/types";
import type { TFunction } from "@/lib/i18n";

const SOURCE_KEYS: Record<string, string> = {
  account: "attempts.proxy.account",
  global: "attempts.proxy.global",
  pool: "attempts.proxy.pool",
};

/**
 * A try that failed at an outbound proxy, in the viewer's language: which proxy it went through,
 * then how the connection failed. A row logged before the server named the proxy says "the proxy".
 * No pool proxy being healthy is one sentence of its own.
 */
export function attemptProxyText(proxy: RequestAttemptProxy, t: TFunction): string {
  if (proxy.code === "no_healthy") return t("attempts.proxy.noHealthy");
  const where = t((proxy.source && SOURCE_KEYS[proxy.source]) || "attempts.proxy.unknown");
  return t("common:text.joinSentences", {
    first: where,
    second: proxyFailureSentence(proxy.code, proxy.status, t),
  });
}

/**
 * A request that failed with a Proxy error, worded as its Attempts word the try that failed at a
 * proxy: the last such try, which is the one the client's error came from. Undefined for any
 * other request, and for a row logged before the server named the proxy failure (its own text
 * then stays the message).
 */
export function requestProxyText(
  record: Pick<RequestRecord, "success" | "errorType" | "attempts">,
  t: TFunction,
): string | undefined {
  if (record.success || record.errorType !== "proxy") return undefined;
  const attempts = record.attempts ?? [];
  for (let index = attempts.length - 1; index >= 0; index--) {
    const proxy = attempts[index]?.proxy;
    if (proxy && !attempts[index]?.success) return attemptProxyText(proxy, t);
  }
  return undefined;
}
