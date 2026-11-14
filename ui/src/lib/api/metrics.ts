import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";

/** GET /metrics settings: the Prometheus endpoint, off by default, read with a bearer token. */
export interface MetricsSettings {
  enabled: boolean;
  /** The bearer token Prometheus sends; "" until the endpoint is first turned on. */
  token: string;
  /** "/metrics" */
  path: string;
}

async function getMetricsSettings(): Promise<MetricsSettings> {
  const res = await apiRequest<Partial<MetricsSettings>>("/metrics");
  return { enabled: res.enabled === true, token: res.token ?? "", path: res.path ?? "/metrics" };
}

export function metricsQuery() {
  return queryOptions({ queryKey: queryKeys.settings.metrics(), queryFn: getMetricsSettings });
}

/** Turns /metrics on or off; `regenerate` makes a new token and the old one stops working. */
export function updateMetricsSettings(body: {
  enabled?: boolean;
  regenerate?: boolean;
}): Promise<MetricsSettings> {
  return apiRequest("/metrics", { method: "POST", body });
}
