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
import { announce } from "@/lib/announce";
import {
  compareVersions,
  fetchReleaseReady,
  fetchRemoteVersion,
  versionQuery,
} from "@/lib/api/system";
import type { RemoteVersionJson, VersionResponse } from "@/lib/api/types";
import { updateStatusQuery } from "@/lib/api/update";
import { useT } from "@/lib/i18n";
import { readStorage, writeStorage } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { type SelfUpdate, useSelfUpdateController } from "./self-update";
import { stripV, UpdateDialog } from "./update-dialog";

/** The silent check waits this long after the shell mounts (old UI: 2 s after sign-in). */
export const SILENT_CHECK_DELAY_MS = 2000;
/**
 * The release the silent check last read out to screen readers. The sidebar's update card shows
 * a newer release for as long as it is known; each release is read out once, not on every visit.
 */
const ANNOUNCED_VERSION_KEY = "kiro_update_announced";
/** How long the row that ran a manual check says its answer ("Kiro Proxy is up to date."). */
export const CHECK_RESULT_MS = 4000;

/** A manual check's answer, said on the row that ran it: the Admin menu's or the palette's. */
export type UpdateCheckResult = "upToDate" | "failed";

interface UpdateCheckValue {
  /** Set once a check found a newer release. */
  latest: RemoteVersionJson | null;
  checking: boolean;
  /** The last manual check's answer, for CHECK_RESULT_MS; null otherwise. */
  checkResult: UpdateCheckResult | null;
  /**
   * Manual check: the row that runs it spins while busy, then says up to date or failed itself
   * (checkResult). A newer release opens the dialog instead, right after `onNewer` (which
   * closes the menu the check ran from).
   */
  checkNow: (onNewer?: () => void) => void;
  openDialog: () => void;
  /** The running version, bare ("3.2.0"); empty until the first check. */
  current: string;
  /** Downloading and installing the newer release from the panel (self-update.tsx). */
  selfUpdate: SelfUpdate;
}

const UpdateCheckContext = createContext<UpdateCheckValue | null>(null);

/**
 * Owns the version check: one silent check shortly after mount (the only allowed external
 * network calls: version.json, then the newer version's GitHub release), the manual check
 * behind the badge and menus, and the update dialog.
 */
export function UpdateCheckProvider({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [latest, setLatest] = useState<RemoteVersionJson | null>(null);
  const [current, setCurrent] = useState("");
  // The server's platform and container flag, for the dialog's How to update steps.
  const [server, setServer] = useState<VersionResponse | undefined>();
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);
  const resultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const busyRef = useRef(false);
  // A manual check can outlive the shell (a sign-out while it runs): its answer is dropped then.
  const mountedRef = useRef(false);
  const openDialog = useCallback(() => setDialogOpen(true), []);
  const tRef = useRef(t);
  tRef.current = t;

  /**
   * Resolves the remote release when it is newer than the running version and its files are out,
   * else null.
   */
  const lookUp = useCallback(async (): Promise<{ newer: RemoteVersionJson | null }> => {
    const [running, remote] = await Promise.all([
      queryClient.ensureQueryData(versionQuery()),
      fetchRemoteVersion(),
    ]);
    const { version } = running;
    setCurrent(stripV(version));
    setServer(running);
    let newer = compareVersions(remote.version, version) > 0 ? remote : null;
    // version.json names a version as soon as it reaches main, minutes before the release workflow
    // has uploaded its files. Until they are on the release there is nothing to download, so the
    // version is not announced yet; a later check finds it.
    if (newer && !(await fetchReleaseReady(newer.version))) newer = null;
    // Whether this server installs the release itself is asked before the release is shown, so
    // the update card appears in its right mode at once: a quick click on a server that updates
    // itself never meets the steps by hand first. An older server without the endpoint is fine.
    if (newer && !running.docker) {
      await queryClient.fetchQuery(updateStatusQuery(true)).catch(() => undefined);
    }
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
          // The card appears in the sidebar by itself; a screen reader hears it once.
          announce(tRef.current("shell.update.availableAnnouncement", { latest: version }));
        })
        // The silent check never reports errors.
        .catch(() => {});
    }, SILENT_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lookUp]);

  const showResult = useCallback((result: UpdateCheckResult | null) => {
    if (resultTimer.current) clearTimeout(resultTimer.current);
    resultTimer.current = null;
    setCheckResult(result);
    if (!result) return;
    resultTimer.current = setTimeout(() => {
      resultTimer.current = null;
      setCheckResult(null);
    }, CHECK_RESULT_MS);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resultTimer.current) clearTimeout(resultTimer.current);
    };
  }, []);

  const checkNow = useCallback(
    (onNewer?: () => void) => {
      if (busyRef.current) return;
      busyRef.current = true;
      showResult(null);
      setChecking(true);
      lookUp()
        .then(
          ({ newer }) => {
            if (!mountedRef.current) return;
            if (newer) {
              onNewer?.();
              openDialog();
              return;
            }
            showResult("upToDate");
            announce(tRef.current("shell.update.upToDate"));
          },
          () => {
            if (!mountedRef.current) return;
            showResult("failed");
            announce(
              `${tRef.current("shell.update.checkFailed")} ${tRef.current("shell.update.checkFailedDetail")}`,
              { assertive: true },
            );
          },
        )
        .finally(() => {
          busyRef.current = false;
          setChecking(false);
        });
    },
    [lookUp, openDialog, showResult],
  );
  const selfUpdate = useSelfUpdateController({
    target: latest ? stripV(latest.version) : "",
    server,
  });
  const value = useMemo(
    () => ({ latest, checking, checkResult, checkNow, openDialog, current, selfUpdate }),
    [latest, checking, checkResult, checkNow, openDialog, current, selfUpdate],
  );

  return (
    <UpdateCheckContext.Provider value={value}>
      {children}
      <UpdateDialog
        current={current}
        latest={latest}
        onOpenChange={setDialogOpen}
        open={dialogOpen && latest !== null}
        selfUpdate={selfUpdate}
        server={server}
      />
    </UpdateCheckContext.Provider>
  );
}

/** The small dot that marks a newer release on the sidebar bell, in the row and the rail. */
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
