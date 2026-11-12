import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { queryKeys } from "./query-keys";
import type { SuccessResponse } from "./types";

/**
 * GET /log-retention (proxy/log_retention.go): how long the request and error logs keep their
 * rows, and what the pruning job did. Pruned rows still count in every all-time total.
 */
export interface LogRetention {
  /** Days of log kept; 0 keeps everything. */
  days: number;
  /** 90: what an install that never set it uses. */
  defaultDays: number;
  /** 3650. */
  maxDays: number;
  /** Unix seconds of the last prune since the server started; 0 when none ran yet. */
  lastRunAt: number;
  lastPrunedRequests: number;
  lastPrunedErrors: number;
  /** Requests pruned so far whose totals are kept. */
  archivedRequests: number;
  /** Unix seconds of the oldest request still in the log; 0 when the log is empty. */
  oldestRequestTs: number;
}

/** 400 `log_retention_range` outside 0..maxDays. Saving starts a prune at once. */
export interface LogRetentionUpdate {
  days: number;
}

function getLogRetention(): Promise<LogRetention> {
  return apiRequest("/log-retention");
}

export function logRetentionQuery() {
  return queryOptions({ queryKey: queryKeys.settings.logRetention(), queryFn: getLogRetention });
}

export function updateLogRetention(body: LogRetentionUpdate): Promise<SuccessResponse> {
  return apiRequest("/log-retention", { method: "POST", body });
}
