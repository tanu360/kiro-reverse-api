/**
 * Screen-reader messages for results the page already shows on its own (a pill that changed, a
 * row that went away, a tick on a button). LiveAnnouncer, mounted once by the app, reads them out
 * from a hidden live region; without it they go nowhere.
 */
interface Announcement {
  text: string;
  /** Read out at once, cutting in: for failures. Otherwise it waits its turn. */
  assertive: boolean;
}

type Listener = (announcement: Announcement) => void;

const listeners = new Set<Listener>();

export function announce(text: string, options: { assertive?: boolean } = {}): void {
  const announcement = { text, assertive: options.assertive ?? false };
  for (const listener of listeners) listener(announcement);
}

export function subscribeAnnouncements(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
