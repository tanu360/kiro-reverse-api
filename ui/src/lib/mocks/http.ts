import { API_BASE } from "@/lib/api/client";

/** '/admin/api' + path, as an MSW pattern (e.g. apiUrl('/accounts/:id')). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function jsonError(
  status: number,
  error: string,
  extra?: Record<string, unknown>,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ error, ...extra }), { status, headers: responseHeaders });
}

/**
 * 401 {"error":"Unauthorized"} unless X-Admin-Token starts with 'mock-'.
 * Skeleton: lets every request through.
 */
export function requireAuth(_request: Request): Response | null {
  return null;
}

/** 0 ms in tests, 120-400 ms otherwise. Skeleton: no delay. */
export function mockDelay(): Promise<void> {
  return Promise.resolve();
}
