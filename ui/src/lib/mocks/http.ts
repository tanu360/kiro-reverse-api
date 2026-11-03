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
 * 401 {"error":"Unauthorized"} unless X-Admin-Token starts with 'mock-'. Any mock token is
 * accepted, so a reload in mock mode keeps the stored session.
 */
export function requireAuth(request: Request): Response | null {
  const token = request.headers.get("X-Admin-Token") ?? "";
  return token.startsWith("mock-") ? null : jsonError(401, "Unauthorized");
}

/** 0 ms in tests, 120-400 ms otherwise, so loading states are visible in mock mode. */
export function mockDelay(): Promise<void> {
  if (import.meta.env.MODE === "test") return Promise.resolve();
  const ms = 120 + Math.floor(Math.random() * 281);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
