import { type JSX, useSyncExternalStore } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { EMPTY, formatDateTime, formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const TICK_MS = 60_000;

// One clock for every RelativeTime on the page: it ticks once a minute while anything listens.
let nowMs = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    nowMs = Date.now();
    timer = setInterval(() => {
      nowMs = Date.now();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getNow(): number {
  return nowMs;
}

/** The current time in ms, updated once a minute (shared by every caller). */
function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, getNow, getNow);
}

/**
 * "5 minutes ago" (or "5m ago" in the narrow style) that stays current, with the full date and
 * time as a tooltip. A muted dash when there is no time. Not a tab stop: the tooltip only repeats
 * the time in full.
 */
export function RelativeTime({
  value,
  style = "long",
  className,
}: {
  /** Unix seconds; 0, null or undefined render the empty dash. */
  value: number | null | undefined;
  style?: "long" | "narrow";
  /** Layout classes only (truncate, min-w-0). */
  className?: string;
}): JSX.Element {
  const { lang } = useT();
  // Re-renders once a minute; the label itself reads the clock at render time.
  useMinuteClock();
  if (!value) return <span className={cn("text-muted-foreground", className)}>{EMPTY}</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            className={cn("whitespace-nowrap tabular-nums", className)}
            dateTime={new Date(value * 1000).toISOString()}
          />
        }
      >
        {formatRelativeTime(value, lang, Date.now(), style)}
      </TooltipTrigger>
      <TooltipPopup>{formatDateTime(value, lang)}</TooltipPopup>
    </Tooltip>
  );
}
