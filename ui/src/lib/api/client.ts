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

/** Skeleton: Task 3 implements the fetch wrapper. */
export function apiRequest<T>(_path: string, _options?: RequestOptions): Promise<T> {
  return Promise.reject(new Error("not implemented"));
}

/** Skeleton: Task 3 implements blob downloads (filename from Content-Disposition). */
export function apiBlob(
  _path: string,
  _options?: RequestOptions,
): Promise<{ blob: Blob; filename: string | null }> {
  return Promise.reject(new Error("not implemented"));
}
