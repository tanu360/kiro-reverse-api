import { useQuery } from "@tanstack/react-query";
import { settingsQuery } from "@/lib/api/settings";
import { type TunnelStatus, tunnelQuery } from "@/lib/api/tunnel";
import type { Settings } from "@/lib/api/types";

function selectRequireApiKey(settings: Settings): boolean {
  return settings.requireApiKey;
}

function selectViaLink(status: TunnelStatus): boolean {
  return status.viaLink;
}

/**
 * Whether a client calling this page's origin must send a key (proxy/auth.go authenticate):
 * Require an API key is on, or this page came through the public link, where every call needs
 * one. Undefined until both answers are in (a failed link status counts as not through it), and
 * while `enabled` is false: a key holder's page, which may not call /admin/api.
 */
export function useKeyRequiredHere(enabled: boolean): boolean | undefined {
  const required = useQuery({ ...settingsQuery(), enabled, select: selectRequireApiKey });
  const viaLink = useQuery({ ...tunnelQuery(), enabled, select: selectViaLink });
  if (required.data === undefined || viaLink.isPending) return undefined;
  return required.data || viaLink.data === true;
}
