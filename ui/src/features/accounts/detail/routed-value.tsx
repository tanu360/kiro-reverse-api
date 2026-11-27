import type { JSX } from "react";
import type { Account, RoutingMode } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { ROUTING_MODE_LABEL, useRoutingMode, useRoutingModeInUse } from "../use-routing-mode";

/**
 * A weight or priority as the account row shows it, with a note while no routing reads it: the
 * value is kept for when the routing mode changes.
 */
export function RoutedValue({
  account,
  mode,
  value,
}: {
  account: Account;
  mode: RoutingMode;
  value: number;
}): JSX.Element {
  const { t } = useT("accounts");
  const inUse = useRoutingModeInUse(mode, account);
  const current = useRoutingMode();
  if (inUse) return <>{value}</>;
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span>{value}</span>
      <span className="text-muted-foreground text-xs">
        {t("detail.routingUnused", { mode: t(ROUTING_MODE_LABEL[current]) })}
      </span>
    </span>
  );
}
