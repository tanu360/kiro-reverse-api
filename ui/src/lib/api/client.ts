import { clearSession, getToken } from "@/lib/auth/session";
import { ApiError } from "./errors";

export const API_BASE = "/admin/api";

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** FormData is sent as-is; anything else is JSON.stringify'd */
  body?: unknown;
  /** undefined/null/'' entries are skipped */
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /** default true; false = no X-Admin-Token and no 401 handling */
  auth?: boolean;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = API_BASE + path;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }
  const search = params.toString();
  return search ? `${url}?${search}` : url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number.parseInt(header, 10);
  return Number.isFinite(seconds) ? seconds : null;
}

async function toApiError(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => "");
  const parsed = parseJson(text);
  const body = parsed.ok ? parsed.value : null;
  // A JSON body speaks through its `error` field; a plain-text body (the 413 from the body-size
  // limit, for example) is the message itself.
  const fromBody =
    isRecord(body) && typeof body.error === "string" ? body.error : parsed.ok ? "" : text.trim();
  return new ApiError({
    status: response.status,
    serverMessage: fromBody || response.statusText,
    body,
    retryAfter: parseRetryAfter(response.headers.get("Retry-After")),
    index: isRecord(body) && typeof body.index === "number" ? body.index : null,
  });
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}

/** Sends the request and returns the response once it is known to be 2xx. */
async function send(path: string, options: RequestOptions): Promise<Response> {
  const { method = "GET", body, query, signal, auth = true } = options;
  const headers = new Headers();
  // The admin password is never sent from here: only POST /session carries it, in the body.
  const token = auth ? getToken() : null;
  if (token) headers.set("X-Admin-Token", token);

  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (body instanceof FormData) {
      // The browser sets the multipart Content-Type with its boundary.
      payload = body;
    } else {
      headers.set("Content-Type", "application/json");
      payload = JSON.stringify(body);
    }
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), { method, headers, body: payload, signal });
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    throw new ApiError({ status: 0, serverMessage: "network" });
  }

  // Only the token this request sent can expire here. A late 401 for an older token (after a
  // password change, a re-login or a restore) must not end the session that replaced it, and
  // once the first 401 clears the token, parallel 401s for it see a different token and stop.
  if (response.status === 401 && token && getToken() === token) {
    clearSession("expired");
  }

  if (!response.ok) throw await toApiError(response);
  return response;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);
  const text = await response.text().catch(() => "");
  if (!text) return undefined as T;
  const parsed = parseJson(text);
  if (!parsed.ok) return text as T;
  const data = parsed.value;
  if (isRecord(data) && data.success === false) {
    throw new ApiError({
      status: response.status,
      serverMessage: typeof data.error === "string" ? data.error : response.statusText,
      body: data,
      index: typeof data.index === "number" ? data.index : null,
    });
  }
  return data as T;
}

function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1].trim());
  } catch {
    return match[1].trim();
  }
}

export async function apiBlob(
  path: string,
  options: RequestOptions = {},
): Promise<{ blob: Blob; filename: string | null }> {
  const response = await send(path, options);
  const blob = await response.blob();
  return { blob, filename: filenameFrom(response.headers.get("Content-Disposition")) };
}
