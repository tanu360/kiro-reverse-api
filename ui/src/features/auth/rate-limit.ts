import { useCallback, useEffect, useState } from "react";
import type { ApiError } from "@/lib/api/errors";

/** Used when a 429 carries no usable Retry-After (the server's window is 1 min). */
export const DEFAULT_RETRY_SECONDS = 60;

// Shorter than a second, so the shown value changes close to each whole second.
const TICK_MS = 250;

/** Seconds to wait after a 429: Retry-After when it is a positive number, else 60. */
export function retrySeconds(error: ApiError): number {
  const seconds = error.retryAfter;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds)
    : DEFAULT_RETRY_SECONDS;
}

/** Whole seconds left until `until` (ms epoch), rounded up and never below 0. */
export function remainingSeconds(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** A countdown in whole seconds. `seconds` is 0 when idle or finished. */
export function useRetryCountdown(): { seconds: number; start: (seconds: number) => void } {
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) setUntil(null);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [until]);

  const start = useCallback((seconds: number) => {
    const current = Date.now();
    setNow(current);
    setUntil(current + seconds * 1000);
  }, []);

  return { seconds: until === null ? 0 : remainingSeconds(until, now), start };
}
