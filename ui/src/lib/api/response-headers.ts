import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type { SuccessResponse } from "./types";

/** One custom header on every client API response (config.ResponseHeaderRule). */
export interface ResponseHeaderRule {
  /** An HTTP token, e.g. "X-Request-Id" */
  name: string;
  /** A template: text with {request_id}, {model}, {account_id}, {key_id}, {client_ip} */
  value: string;
  enabled: boolean;
}

/** GET /response-headers */
export interface ResponseHeadersResponse {
  headers: ResponseHeaderRule[];
  /** The variable names a value may use, in the order the editor offers them. */
  variables: string[];
  /** At most this many headers (20). */
  max: number;
}

/** POST /response-headers replaces the whole list. */
export interface ResponseHeadersUpdate {
  headers: ResponseHeaderRule[];
}

async function getResponseHeaders(): Promise<ResponseHeadersResponse> {
  const res = await apiRequest<ResponseHeadersResponse>("/response-headers");
  return { ...res, headers: res.headers ?? [], variables: res.variables ?? [] };
}

export function responseHeadersQuery() {
  return queryOptions({
    queryKey: queryKeys.settings.responseHeaders(),
    queryFn: getResponseHeaders,
  });
}

/**
 * 400 with `code` and, for one entry, its `index` (-1 for the list as a whole), e.g.
 * response_header_name_forbidden.
 */
export function updateResponseHeaders(body: ResponseHeadersUpdate): Promise<SuccessResponse> {
  return apiRequest("/response-headers", { method: "POST", body });
}
