import { proxyFailureSentence } from "@/features/proxy-pool/lib/pool-failure";
import type { RequestAttemptProxy } from "@/lib/api/types";
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
