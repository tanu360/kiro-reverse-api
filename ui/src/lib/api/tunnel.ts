import { queryOptions } from "@tanstack/react-query";
import type { TFunction } from "@/lib/i18n";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import { withDetail } from "./server-errors";

/**
 * Where the public link stands (proxy/tunnel_api.go): off, fetching the Tailscale helper,
 * connecting, waiting on the user at Tailscale (sign-in, device approval, Funnel), live, or failed.
 */
type TunnelState =
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
  /** Why it failed, in plain English; the UI words it from `errorCode` (tunnelErrorText). */
  error?: string;
  /** The failure's code (tunnel/tunnel.go Code*); absent from servers before it. */
  errorCode?: string;
  /** The underlying reason, shown as is after the translated text. */
  errorDetail?: string;
  /**
   * While running: when Tailscale signs this server out and the link stops (ISO 8601). Absent
   * once key expiry is off for the device, or from a helper too old to say.
   */
  keyExpiry?: string;
  /** This device's page in the Tailscale admin console, where key expiry is turned off. */
  machineURL?: string;
  /**
   * While running without a link: Funnel is on and the certificate is in, and the server waits
   * for the link to open from the internet. Tailscale can take a few minutes to put it online.
   */
  publishing?: boolean;
  /** A Tailscale sign-in is saved on this server. */
  signedIn: boolean;
  /** An earlier version's helper runs, because this version's could not be downloaded. */
  fallbackHelper: boolean;
  /** Admin two-factor sign-in is on. */
  twoFactor: boolean;
  /** At least one API key is on: public API calls always need one. */
  apiKeys: boolean;
  /**
   * This page came through the link: a new device name or turning the link off would disconnect
   * it, so the name is locked and the switch asks first.
   */
  viaLink: boolean;
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
function tunnelWaiting(status: TunnelStatus): boolean {
  return WAITING.has(status.state) || (status.state === "running" && !status.url);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function dateString(value: unknown): string | undefined {
  const text = optionalString(value);
  return text && Number.isFinite(Date.parse(text)) ? text : undefined;
}

function httpsURL(value: unknown): string | undefined {
  const text = optionalString(value);
  return text?.startsWith("https://") ? text : undefined;
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
    errorCode: optionalString(res.errorCode),
    errorDetail: optionalString(res.errorDetail),
    keyExpiry: dateString(res.keyExpiry),
    machineURL: httpsURL(res.machineURL),
    publishing: res.publishing === true,
    signedIn: res.signedIn === true,
    fallbackHelper: res.fallbackHelper === true,
    twoFactor: res.twoFactor === true,
    apiKeys: res.apiKeys === true,
    viaLink: res.viaLink === true,
  };
}

/** Status.ErrorCode (tunnel/tunnel.go) -> translation key. */
const TUNNEL_ERROR_KEYS: Readonly<Record<string, string>> = {
  helper_stopped: "errors:tunnelError.helperStopped",
  helper_download_failed: "errors:tunnelError.helperDownloadFailed",
  helper_start_failed: "errors:tunnelError.helperStartFailed",
  helper_mismatch: "errors:tunnelError.helperMismatch",
  listener_failed: "errors:tunnelError.listenerFailed",
  helper_error: "errors:tunnelError.helperError",
};

/**
 * Why the link failed, in the UI language: the code's text with the server's detail after it.
 * An unknown code (or a server without codes) shows the server's English; undefined when there
 * is no reason at all.
 */
export function tunnelErrorText(
  status: Pick<TunnelStatus, "error" | "errorCode" | "errorDetail">,
  t: TFunction,
): string | undefined {
  const key = status.errorCode ? TUNNEL_ERROR_KEYS[status.errorCode] : undefined;
  return key ? withDetail(t(key), status.errorDetail, t) : status.error;
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
