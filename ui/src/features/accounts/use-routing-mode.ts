import { useQuery } from "@tanstack/react-query";
import { settingsQuery } from "@/lib/api/settings";
import type { RoutingMode, Settings } from "@/lib/api/types";

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
