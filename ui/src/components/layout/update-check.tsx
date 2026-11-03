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
import { toast } from "@/lib/toast";
import { stripV, UpdateDialog } from "./update-dialog";

/** The silent check waits this long after the shell mounts (old UI: 2 s after sign-in). */
export const SILENT_CHECK_DELAY_MS = 2000;
const AVAILABLE_TOAST_MS = 5200;
const UP_TO_DATE_TOAST_MS = 3600;

interface UpdateCheckValue {
  /** Set once a check found a newer release. */
  latest: RemoteVersionJson | null;
  checking: boolean;
  /** Manual check: spinner while busy, toast when up to date or failed, dialog when newer. */
  checkNow: () => void;
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
          toast.warning(tRef.current("shell.update.available", { latest: stripV(newer.version) }), {
            id: "update-available",
            duration: AVAILABLE_TOAST_MS,
            action: {
              label: tRef.current("shell.update.view"),
              onClick: () => setDialogOpen(true),
            },
          });
        })
        // The silent check never reports errors.
        .catch(() => {});
    }, SILENT_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lookUp]);

  const checkNow = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    setChecking(true);
    lookUp()
      .then(({ newer }) => {
        if (newer) {
          setDialogOpen(true);
          return;
        }
        toast.success(tRef.current("shell.update.upToDate"), { duration: UP_TO_DATE_TOAST_MS });
      })
      .catch(() => {
        toast.error(tRef.current("shell.update.checkFailed"), {
          description: tRef.current("shell.update.checkFailedDetail"),
        });
      })
      .finally(() => {
        busyRef.current = false;
        setChecking(false);
      });
  }, [lookUp]);

  const openDialog = useCallback(() => setDialogOpen(true), []);
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

export function useUpdateCheck(): UpdateCheckValue {
  const context = useContext(UpdateCheckContext);
  if (!context) throw new Error("useUpdateCheck must be used within an UpdateCheckProvider");
  return context;
}
