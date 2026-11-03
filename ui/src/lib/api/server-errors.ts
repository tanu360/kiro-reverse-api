import type { TFunction } from "@/lib/i18n";

/** Exact server error message -> 'errors:<key>'. Task 3 fills the table. */
export const SERVER_ERROR_KEYS: Readonly<Record<string, string>> = {};

/** Trimmed, case-insensitive lookup in SERVER_ERROR_KEYS. Skeleton: no match. */
export function serverErrorKey(_message: string): string | null {
  return null;
}

/** User-facing message for any thrown value. Skeleton: the error's own message. */
export function errorMessage(error: unknown, _t: TFunction, _fallbackKey?: string): string {
  return error instanceof Error ? error.message : String(error);
}
