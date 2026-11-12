import type { JSX } from "react";
import { StatusDot } from "@/components/shared/status-dot";
import { Badge } from "@/components/ui/badge";
import type { ProxyPoolView } from "@/lib/api/proxy-pool";
import { useT } from "@/lib/i18n";
import { assignedProxy, proxyName, statusLook } from "./lib/pool-model";

const DOT_TONE = { success: "success", destructive: "destructive", neutral: "muted" } as const;

/**
 * The pool proxy an account without a proxy of its own is on: its name with a status dot and a
 * Pool badge, or "Assigned on the next request" before its first request through the pool.
 */
export function PoolProxyValue({
  accountId,
  view,
}: {
  accountId: string;
  view: ProxyPoolView;
}): JSX.Element {
  const { t } = useT("proxy-pool");
  const proxy = assignedProxy(view, accountId);
  const look = proxy ? statusLook(proxy.health.status) : undefined;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {proxy && look ? (
        <>
          <StatusDot label={t(look.key)} tone={DOT_TONE[look.tone]} />
          <span
            className={proxy.label ? "min-w-0 truncate" : "min-w-0 truncate font-mono"}
            translate={proxy.label ? undefined : "no"}
          >
            {proxyName(proxy)}
          </span>
        </>
      ) : (
        <span className="min-w-0 truncate">{t("account.pending")}</span>
      )}
      <Badge size="sm" tone="primary">
        {t("account.pool")}
      </Badge>
    </span>
  );
}
