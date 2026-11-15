import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";

/**
 * Where the public link stands (proxy/tunnel_api.go): off, fetching the Tailscale helper,
 * connecting, waiting on the user at Tailscale (sign-in, device approval, Funnel), live, or failed.
 */
export type TunnelState =
  | "off"
  | "downloading"
  | "starting"
  | "needs-login"
  | "needs-approval"
  | "needs-funnel"
  | "running"
  | "error";

/** GET /tunnel: the public link through Tailscale Funnel. */
export interface TunnelStatus {
  /** The saved switch. */
  enabled: boolean;
  /** The device name; the link is https://<hostname>.<tailnet>.ts.net. */
  hostname: string;
  /** "kiro-proxy" */
  defaultHostname: string;
  state: TunnelState;
  /** 0 to 100 while downloading; absent when the size is unknown. */
  progress?: number;
  /** Bytes of the helper download so far, and its size (absent when unknown). */
  downloaded?: number;
  total?: number;
  /** The public link, while running. */
  url?: string;
  /** Tailscale's sign-in page, while it waits for a sign-in. */
  authURL?: string;
  /** The page that turns on HTTPS and Funnel for the tailnet. */
  enableURL?: string;
  /** The Tailscale admin console, while the device waits for approval. */
  adminURL?: string;
  /** Why it failed, in plain English. */
  error?: string;
  /** A Tailscale sign-in is saved on this server. */
  signedIn: boolean;
  /** Admin two-factor sign-in is on. */
  twoFactor: boolean;
  /** At least one API key is on: public API calls always need one. */
  apiKeys: boolean;
}

/** One DNS label, as the server checks it (config.ValidTunnelHostname). */
export const TUNNEL_HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const TUNNEL_HOSTNAME_MAX = 63;

const TUNNEL_STATES: readonly TunnelState[] = [
  "off",
  "downloading",
  "starting",
  "needs-login",
  "needs-approval",
  "needs-funnel",
  "running",
  "error",
];

/** States that move on their own or wait on the user at Tailscale: polled while shown. */
const WAITING: ReadonlySet<TunnelState> = new Set([
  "downloading",
  "starting",
  "needs-login",
  "needs-approval",
  "needs-funnel",
]);

/**
 * Whether the link is on its way, "running" with no link yet (the certificate) included: the card
 * polls every 2 s then, in case events are off.
 */
export function tunnelWaiting(status: TunnelStatus): boolean {
  return WAITING.has(status.state) || (status.state === "running" && !status.url);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function byteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

/** The server's answer with every field in its type; an unknown state reads as an error. */
function normalize(res: Partial<Record<keyof TunnelStatus, unknown>>): TunnelStatus {
  const defaultHostname = optionalString(res.defaultHostname) ?? "kiro-proxy";
  const state = TUNNEL_STATES.includes(res.state as TunnelState)
    ? (res.state as TunnelState)
    : "error";
  return {
    enabled: res.enabled === true,
    hostname: optionalString(res.hostname) ?? defaultHostname,
    defaultHostname,
    state,
    progress:
      typeof res.progress === "number" && Number.isFinite(res.progress)
        ? Math.min(100, Math.max(0, Math.round(res.progress)))
        : undefined,
    downloaded: byteCount(res.downloaded),
    total: byteCount(res.total),
    url: optionalString(res.url),
    authURL: optionalString(res.authURL),
    enableURL: optionalString(res.enableURL),
    adminURL: optionalString(res.adminURL),
    error: optionalString(res.error),
    signedIn: res.signedIn === true,
    twoFactor: res.twoFactor === true,
    apiKeys: res.apiKeys === true,
  };
}

async function getTunnel(): Promise<TunnelStatus> {
  return normalize(await apiRequest("/tunnel"));
}

export function tunnelQuery() {
  return queryOptions({
    queryKey: queryKeys.settings.tunnel(),
    queryFn: getTunnel,
    refetchInterval: (query) =>
      query.state.data && tunnelWaiting(query.state.data) ? 2000 : false,
  });
}

/** Turns the link on or off, or renames the device (which restarts a running link). */
export async function updateTunnel(body: {
  enabled?: boolean;
  hostname?: string;
}): Promise<TunnelStatus> {
  return normalize(await apiRequest("/tunnel", { method: "POST", body }));
}

/** Signs this server out of Tailscale: the link stops and the saved sign-in is forgotten. */
export async function logoutTunnel(): Promise<TunnelStatus> {
  return normalize(await apiRequest("/tunnel/logout", { method: "POST" }));
}
