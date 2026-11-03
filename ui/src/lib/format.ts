import type { Lang } from "@/lib/i18n";

export const EMPTY = "—";

// Skeleton: Task 3 implements the formatters. Each one returns String(value) until then.

export function formatNumber(value: number, _lang?: Lang): string {
  return String(value);
}

export function formatDecimal(value: number, _digits: number, _lang?: Lang): string {
  return String(value);
}

export function formatCompact(value: number): string {
  return String(value);
}

export function formatPercent(part: number, _total: number): string {
  return String(part);
}

export function formatFraction(fraction: number, _digits?: number): string {
  return String(fraction);
}

export function formatCredits(value: number, _digits?: number): string {
  return String(value);
}

export function formatUsd(value: number): string {
  return String(value);
}

export function formatBytes(bytes: number, _lang?: Lang): string {
  return String(bytes);
}

export function formatDurationMs(ms: number | undefined, _hasEndpoint: boolean): string {
  return String(ms);
}

export function formatUptime(seconds: number, _lang: Lang): string {
  return String(seconds);
}

export function formatDateTime(unixSec: number, _lang: Lang): string {
  return String(unixSec);
}

export function formatTime(unixSec: number, _lang: Lang): string {
  return String(unixSec);
}

export function formatRelativeTime(unixSec: number, _lang: Lang, _nowMs?: number): string {
  return String(unixSec);
}

export function unixToDate(unixSec: number): Date {
  return new Date(unixSec * 1000);
}
