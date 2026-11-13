import { buildProxyUrl, type ProxyModel, parseProxyUrl } from "@/features/settings/lib/proxy-url";
import type {
  PoolProxy,
  PoolProxyInput,
  PoolProxyStatus,
  ProxyPoolView,
} from "@/lib/api/proxy-pool";
import { errorMessage, serverErrorCode } from "@/lib/api/server-errors";
import type { TFunction } from "@/lib/i18n";

/** The longest label the server accepts, in characters. */
export const MAX_LABEL = 64;

/** Minutes the interval select offers; 0 is off. A saved value outside the list is added. */
const INTERVAL_PRESETS = [0, 1, 5, 10, 30, 60] as const;

export function intervalOptions(current: number): number[] {
  const values = new Set<number>(INTERVAL_PRESETS);
  if (Number.isInteger(current) && current >= 0) values.add(current);
  return [...values].sort((a, b) => a - b);
}

type Tone = "success" | "destructive" | "neutral";

/** The badge tone and label key of a health status. */
export function statusLook(status: PoolProxyStatus): { tone: Tone; key: string } {
  if (status === "ok") return { tone: "success", key: "proxy-pool:status.ok" };
  if (status === "failed") return { tone: "destructive", key: "proxy-pool:status.failed" };
  return { tone: "neutral", key: "proxy-pool:status.unknown" };
}

/** The label, or the address when the proxy has none. */
export function proxyName(proxy: Pick<PoolProxy, "label" | "url">): string {
  return proxy.label?.trim() || proxy.url;
}

/** The pool proxy an account is on, if any. */
export function assignedProxy(view: ProxyPoolView, accountId: string): PoolProxy | undefined {
  const id = view.assignments[accountId];
  return id ? view.proxies.find((proxy) => proxy.id === id) : undefined;
}

/** An account without its own proxy goes through the pool while it is on and has proxies. */
export function routesThroughPool(view: ProxyPoolView | undefined): view is ProxyPoolView {
  return view !== undefined && view.mode === "on" && view.proxies.length > 0;
}

/** The editor's state: the shared proxy form plus the label and the password choice. */
export interface EditorModel {
  label: string;
  proxy: ProxyModel;
  /** Edit only: drop the saved password. */
  clearPassword: boolean;
}

/** A new proxy starts as SOCKS5; an edit starts from the saved address and username. */
export function editorModel(proxy?: PoolProxy): EditorModel {
  if (!proxy) {
    return {
      label: "",
      proxy: { type: "socks5", scheme: "socks5", host: "", port: "", username: "", password: "" },
      clearPassword: false,
    };
  }
  const parsed = parseProxyUrl(proxy.url);
  return {
    label: proxy.label ?? "",
    proxy: { ...parsed, username: proxy.username ?? "", password: "" },
    clearPassword: false,
  };
}

export interface EditorErrors {
  host: boolean;
  /** The host holds a port (host:port typed in one field); IPv6 hosts have more colons. */
  hostPort: boolean;
  port: boolean;
  label: boolean;
}

function validPort(port: string): boolean {
  const value = Number(port);
  return /^\d+$/.test(port) && value >= 1 && value <= 65535;
}

export function editorErrors(model: EditorModel): EditorErrors {
  const host = model.proxy.host.trim();
  return {
    host: host === "",
    hostPort: host.split(":").length === 2,
    port: !validPort(model.proxy.port.trim()),
    label: [...model.label.trim()].length > MAX_LABEL,
  };
}

export function hasErrors(errors: EditorErrors): boolean {
  return errors.host || errors.hostPort || errors.port || errors.label;
}

/**
 * The request body. The address goes without sign-in; the username and password go as their
 * own fields. On an edit an empty password field keeps the saved one unless Clear is ticked.
 */
export function editorRequest(model: EditorModel, editing: boolean): PoolProxyInput {
  const url = buildProxyUrl({ ...model.proxy, username: "", password: "" });
  const username = model.proxy.username.trim();
  const password = model.proxy.password;
  const body: PoolProxyInput = { label: model.label.trim(), url, username };
  if (password !== "") body.password = password;
  else if (!editing || model.clearPassword) body.password = "";
  if (!username) body.password = "";
  return body;
}

const POOL_ERROR_KEYS: Record<string, string> = {
  proxy_pool_invalid: "proxy-pool:serverError.invalid",
  proxy_pool_duplicate: "proxy-pool:serverError.duplicate",
  proxy_pool_not_found: "proxy-pool:serverError.notFound",
  proxy_pool_empty: "proxy-pool:serverError.empty",
  proxy_pool_full: "proxy-pool:serverError.full",
};

/** A pool error code's own text (with the server's detail), or the app's usual error text. */
export function poolErrorMessage(error: unknown, t: TFunction): string {
  const code = serverErrorCode(error);
  const key = code ? POOL_ERROR_KEYS[code] : undefined;
  if (!key) return errorMessage(error, t);
  const body = (error as { body?: unknown }).body;
  const raw =
    typeof body === "object" && body !== null ? (body as { detail?: unknown }).detail : "";
  const detail = typeof raw === "string" ? raw.trim() : "";
  return detail
    ? t("common:text.joinSentences", {
        first: t(key),
        second: t("errors:serverError.detail", { detail }),
      })
    : t(key);
}
