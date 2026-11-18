import { type JSX, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { subscribeAnnouncements } from "@/lib/announce";

/** Long enough to be read out; then the region empties, so a stale line is not found later. */
const CLEAR_MS = 7000;
/** The region is emptied first and filled a beat later, so the same line twice is read twice. */
const FILL_MS = 50;

/**
 * The app's hidden live regions for `announce()`: one polite, one assertive. They stay mounted
 * and empty, as a live region must exist before its text changes to be read. No status or alert
 * role, so they never count among the page's own. A portal puts them at the end of document.body,
 * out of the app's own markup (and out of a test's render container).
 */
export function LiveAnnouncer(): JSX.Element {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
    };
    const unsubscribe = subscribeAnnouncements(({ text, assertive: urgent }) => {
      const set = urgent ? setAssertive : setPolite;
      set("");
      later(() => {
        set(text);
        later(() => set((current) => (current === text ? "" : current)), CLEAR_MS);
      }, FILL_MS);
    });
    return () => {
      unsubscribe();
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);

  return createPortal(
    <div className="sr-only" data-slot="live-announcer">
      <div aria-atomic="true" aria-live="polite">
        {polite}
      </div>
      <div aria-atomic="true" aria-live="assertive">
        {assertive}
      </div>
    </div>,
    document.body,
  );
}
