import { useQuery } from "@tanstack/react-query";
import { apiKeysQuery } from "@/lib/api/api-keys";
import { settingsQuery } from "@/lib/api/settings";
import { type TunnelStatus, tunnelQuery } from "@/lib/api/tunnel";
import type { Account, ApiKey, RoutingMode, Settings } from "@/lib/api/types";
import { hasTag } from "./account-metadata";

export const ROUTING_MODES: readonly RoutingMode[] = ["weighted", "priority", "reset_first"];

/** The full locale key of each mode's label, for any namespace. */
export const ROUTING_MODE_LABEL: Readonly<Record<RoutingMode, string>> = {
  weighted: "settings:routingMode.weighted",
  priority: "settings:routingMode.priority",
  reset_first: "settings:routingMode.resetFirst",
};

export function isRoutingMode(value: unknown): value is RoutingMode {
  return ROUTING_MODES.includes(value as RoutingMode);
}

function selectRoutingMode(settings: Settings): RoutingMode {
  return isRoutingMode(settings.routingMode) ? settings.routingMode : "weighted";
}

/**
 * The server's routing mode, from the cached GET /settings. Weighted, the server's default, until
 * the settings load or when they fail, so the list never shows priorities that do not apply.
 */
export function useRoutingMode(): RoutingMode {
  const { data } = useQuery({ ...settingsQuery(), select: selectRoutingMode });
  return data ?? "weighted";
}

/**
 * The keys whose own routing mode replaces the server's for their requests (pool/account.go
 * resolveRoutingMode): on, not expired (their clients get 401) and with a mode of their own.
 * None while no request is checked for a key: API keys not required and the public link off
 * (proxy/auth.go authenticate).
 */
export function useKeysWithOwnRoutingMode(): ApiKey[] {
  const { data: required } = useQuery({ ...settingsQuery(), select: selectRequireApiKey });
  const { data: linkOn } = useQuery({ ...tunnelQuery(), select: selectTunnelEnabled });
  const { data: keys } = useQuery(apiKeysQuery());
  if (!required && !linkOn) return [];
  return (keys ?? []).filter(
    (key) =>
      key.enabled && !key.expired && key.routingMode !== undefined && key.routingMode !== "inherit",
  );
}

function selectRequireApiKey(settings: Settings): boolean {
  return settings.requireApiKey;
}

function selectTunnelEnabled(status: TunnelStatus): boolean {
  return status.enabled;
}

/**
 * Whether a key reaches the account: unscoped, or it lists the account by id or by one of its
 * tags, ignoring case (config.ApiKeyAllowedAccounts).
 */
function keyReaches(key: ApiKey, account: Pick<Account, "id" | "tags">): boolean {
  const ids = key.accountIds ?? [];
  const tags = key.accountTags ?? [];
  if (ids.length === 0 && tags.length === 0) return true;
  return ids.includes(account.id) || tags.some((tag) => hasTag(account, tag));
}

/**
 * Whether some routing over the account uses mode: the server's own, or the own mode of a key that
 * reaches the account. A weight is read only in weighted routing and a priority only in priority
 * routing.
 */
export function useRoutingModeInUse(
  mode: RoutingMode,
  account: Pick<Account, "id" | "tags">,
): boolean {
  const global = useRoutingMode();
  const keys = useKeysWithOwnRoutingMode();
  return (
    global === mode || keys.some((key) => key.routingMode === mode && keyReaches(key, account))
  );
}
