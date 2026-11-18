import { useCallback, useEffect, useRef, useState } from "react";

/** How long a Save button reads "Saved" after a save. */
const SAVED_FLASH_MS = 2000;

/**
 * A short "Saved" state for a Save button: `flash()` turns it on, and it goes off by itself
 * after `ms` (or at once with `clear()`).
 */
export function useSavedFlash(ms: number = SAVED_FLASH_MS): {
  saved: boolean;
  flash: () => void;
  clear: () => void;
} {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setSaved(false);
  }, []);

  const flash = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setSaved(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setSaved(false);
    }, ms);
  }, [ms]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { saved, flash, clear };
}
