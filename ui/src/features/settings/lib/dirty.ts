import { useCallback, useState } from "react";

/** Structural equality for JSON-like values (objects, arrays, primitives). */
export function isEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => isEqual(item, b[i]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).filter((key) => aRecord[key] !== undefined);
  const bKeys = Object.keys(bRecord).filter((key) => bRecord[key] !== undefined);
  return aKeys.length === bKeys.length && aKeys.every((key) => isEqual(aRecord[key], bRecord[key]));
}

interface DraftState<T> {
  /** The value the draft started from: the last adopted server copy or the last saved value. */
  base: T;
  draft: T;
  /** The last server copy passed in. */
  seen: T;
  /** A new server copy arrived while the draft was dirty. */
  serverChanged: boolean;
}

export function initialDraftState<T>(server: T): DraftState<T> {
  return { base: server, draft: server, seen: server, serverChanged: false };
}

/**
 * The state after the server copy is (re)read. A clean draft takes a new copy; a dirty draft is
 * kept and only flags the change, so a refetch never overwrites local edits.
 */
export function receiveServer<T>(
  state: DraftState<T>,
  server: T,
  equal: (a: T, b: T) => boolean,
): DraftState<T> {
  if (equal(state.seen, server)) return state;
  if (equal(state.draft, state.base)) return initialDraftState(server);
  return { ...state, seen: server, serverChanged: true };
}

export interface Draft<T> {
  value: T;
  set: (next: T | ((prev: T) => T)) => void;
  /** The draft differs from what it started from. */
  dirty: boolean;
  /** The server copy changed while the draft was dirty. */
  serverChanged: boolean;
  /** Drops the draft and takes the latest server copy. */
  reload: () => void;
  /** The saved value becomes the new starting point; the next server copy replaces it. */
  commit: (saved: T) => void;
}

/** Local edit state for one settings card on top of its server copy. */
export function useDraft<T>(server: T, equal: (a: T, b: T) => boolean = isEqual): Draft<T> {
  const [state, setState] = useState<DraftState<T>>(() => initialDraftState(server));

  // Adjusting state during render (instead of in an effect) avoids one frame of stale values.
  let current = state;
  const next = receiveServer(state, server, equal);
  if (next !== state) {
    current = next;
    setState(next);
  }

  const set = useCallback((value: T | ((prev: T) => T)) => {
    setState((prev) => ({
      ...prev,
      draft: typeof value === "function" ? (value as (prev: T) => T)(prev.draft) : value,
    }));
  }, []);

  const reload = useCallback(() => {
    setState((prev) => initialDraftState(prev.seen));
  }, []);

  const commit = useCallback((saved: T) => {
    // `seen` stays: the cache write or refetch that brings the saved copy then replaces the
    // clean draft, including a normalised copy such as lowercased mapping keys.
    setState((prev) => ({ ...prev, base: saved, draft: saved, serverChanged: false }));
  }, []);

  const dirty = !equal(current.draft, current.base);
  return {
    value: current.draft,
    set,
    dirty,
    serverChanged: dirty && current.serverChanged,
    reload,
    commit,
  };
}
