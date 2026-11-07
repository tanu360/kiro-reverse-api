import { useQueryClient } from "@tanstack/react-query";
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
import { compareVersions, fetchRemoteVersion, versionQuery } from "@/lib/api/system";
import type { RemoteVersionJson } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { readStorage, writeStorage } from "@/lib/storage";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { stripV, UpdateDialog } from "./update-dialog";

/** The silent check waits this long after the shell mounts (old UI: 2 s after sign-in). */
export const SILENT_CHECK_DELAY_MS = 2000;
const AVAILABLE_TOAST_MS = 5200;
const AVAILABLE_TOAST_ID = "update-available";
/**
 * The release the silent check last announced with a toast. Each release gets one toast; after
 * that the header button's dot carries the notice, so the toast does not cover the page (the
 * sticky Settings chips on a phone) on every visit.
 */
const ANNOUNCED_VERSION_KEY = "kiro_update_announced";
const UP_TO_DATE_TOAST_MS = 3600;

interface UpdateCheckValue {
  /** Set once a check found a newer release. */
  latest: RemoteVersionJson | null;
  checking: boolean;
  /**
   * Manual check: spinner while busy, toast when up to date or failed, dialog when newer.
   * `onSettled` runs once the answer is in, just before that toast or dialog shows (the Admin
   * menu closes there, so its spinner row stays up while the check runs).
   */
  checkNow: (onSettled?: () => void) => void;
  openDialog: () => void;
}

const UpdateCheckContext = createContext<UpdateCheckValue | null>(null);

/**
 * Owns the version check: one silent check shortly after mount (the only allowed external
 * network call), the manual check behind the badge and menus, and the update dialog.
 */
export function UpdateCheckProvider({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [latest, setLatest] = useState<RemoteVersionJson | null>(null);
  const [current, setCurrent] = useState("");
  const [checking, setChecking] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const busyRef = useRef(false);
  // The dialog says what the toast said, so opening it retires the toast.
  const openDialog = useCallback(() => {
    toast.dismiss(AVAILABLE_TOAST_ID);
    setDialogOpen(true);
  }, []);
  const tRef = useRef(t);
  tRef.current = t;

  /** Resolves the remote release when it is newer than the running version, else null. */
  const lookUp = useCallback(async (): Promise<{ newer: RemoteVersionJson | null }> => {
    const [{ version }, remote] = await Promise.all([
      queryClient.ensureQueryData(versionQuery()),
      fetchRemoteVersion(),
    ]);
    setCurrent(stripV(version));
    const newer = compareVersions(remote.version, version) > 0 ? remote : null;
    if (newer) setLatest(newer);
    return { newer };
  }, [queryClient]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      lookUp()
        .then(({ newer }) => {
          if (cancelled || !newer) return;
          const version = stripV(newer.version);
          if (readStorage(ANNOUNCED_VERSION_KEY) === version) return;
          writeStorage(ANNOUNCED_VERSION_KEY, version);
          toast.warning(tRef.current("shell.update.available", { latest: version }), {
            id: AVAILABLE_TOAST_ID,
            duration: AVAILABLE_TOAST_MS,
            action: { label: tRef.current("shell.update.view"), onClick: openDialog },
          });
        })
        // The silent check never reports errors.
        .catch(() => {});
    }, SILENT_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lookUp, openDialog]);

  const checkNow = useCallback(
    (onSettled?: () => void) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setChecking(true);
      lookUp()
        .then(
          ({ newer }) => {
            onSettled?.();
            if (newer) {
              openDialog();
              return;
            }
            toast.success(tRef.current("shell.update.upToDate"), {
              duration: UP_TO_DATE_TOAST_MS,
            });
          },
          () => {
            onSettled?.();
            toast.error(tRef.current("shell.update.checkFailed"), {
              description: tRef.current("shell.update.checkFailedDetail"),
            });
          },
        )
        .finally(() => {
          busyRef.current = false;
          setChecking(false);
        });
    },
    [lookUp, openDialog],
  );
  const value = useMemo(
    () => ({ latest, checking, checkNow, openDialog }),
    [latest, checking, checkNow, openDialog],
  );

  return (
    <UpdateCheckContext.Provider value={value}>
      {children}
      <UpdateDialog
        current={current}
        latest={latest}
        onOpenChange={setDialogOpen}
        open={dialogOpen && latest !== null}
      />
    </UpdateCheckContext.Provider>
  );
}

/** The small dot that marks a newer release on the badge, the rail and the header button. */
export function UpdateDot({ className }: { className?: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute size-2 rounded-full bg-warning outline-2 outline-background",
        className,
      )}
      data-slot="update-dot"
    />
  );
}

export function useUpdateCheck(): UpdateCheckValue {
  const context = useContext(UpdateCheckContext);
  if (!context) throw new Error("useUpdateCheck must be used within an UpdateCheckProvider");
  return context;
}
