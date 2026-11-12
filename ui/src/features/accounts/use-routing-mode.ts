import { useQuery } from "@tanstack/react-query";
import { settingsQuery } from "@/lib/api/settings";
import type { RoutingMode, Settings } from "@/lib/api/types";

function selectRoutingMode(settings: Settings): RoutingMode {
  return settings.routingMode === "priority" ? "priority" : "weighted";
}

/**
 * The server's routing mode, from the cached GET /settings. Weighted, the server's default, until
 * the settings load or when they fail, so the list never shows priorities that do not apply.
 */
export function useRoutingMode(): RoutingMode {
  const { data } = useQuery({ ...settingsQuery(), select: selectRoutingMode });
  return data ?? "weighted";
}
