import { useQuery } from "@tanstack/react-query";
import { settingsQuery } from "@/lib/api/settings";
import type { Settings } from "@/lib/api/types";

function selectAllowOverUsage(settings: Settings): boolean {
  return settings.allowOverUsage === true;
}

/**
 * The server's Allow over usage, from the cached GET /settings: while it is on the pool keeps
 * serving accounts past their plan credits (pool/account.go). Off, the server's default, until
 * the settings load or when they fail.
 */
export function useAllowOverUsage(): boolean {
  const { data } = useQuery({ ...settingsQuery(), select: selectAllowOverUsage });
  return data ?? false;
}
