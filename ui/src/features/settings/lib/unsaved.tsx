import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface UnsavedChanges {
  /** Section ids with edits that are not saved yet, in no particular order. */
  dirty: ReadonlySet<string>;
  /** Read at navigation time, so a blocker never sees a stale render. */
  isDirty: () => boolean;
  report: (sectionId: string, dirty: boolean) => void;
}

const UnsavedChangesContext = createContext<UnsavedChanges | null>(null);

/** Collects which settings cards hold unsaved edits, for the leave-page guard and the nav. */
export function UnsavedChangesProvider({ children }: { children: ReactNode }): JSX.Element {
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const report = useCallback((sectionId: string, isDirty: boolean) => {
    setDirty((prev) => {
      if (prev.has(sectionId) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(sectionId);
      else next.delete(sectionId);
      return next;
    });
  }, []);

  const isDirty = useCallback(() => dirtyRef.current.size > 0, []);
  const value = useMemo(() => ({ dirty, isDirty, report }), [dirty, isDirty, report]);
  return <UnsavedChangesContext.Provider value={value}>{children}</UnsavedChangesContext.Provider>;
}

/** The page's unsaved-changes state; null outside the provider (a card rendered on its own). */
export function useUnsavedChanges(): UnsavedChanges | null {
  return useContext(UnsavedChangesContext);
}

/** Reports one card's dirty flag while it is mounted; an unmounted card has nothing to lose. */
export function useReportDirty(sectionId: string | undefined, dirty: boolean): void {
  const report = useContext(UnsavedChangesContext)?.report;
  useEffect(() => {
    if (!report || !sectionId) return;
    report(sectionId, dirty);
  }, [report, sectionId, dirty]);
  useEffect(() => {
    if (!report || !sectionId) return;
    return () => report(sectionId, false);
  }, [report, sectionId]);
}
