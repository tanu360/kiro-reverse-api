import { Alert02Icon, Download04Icon, ReloadIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/api/query-keys";
import type { VersionResponse } from "@/lib/api/types";
import {
  restartForUpdate,
  startUpdate,
  type UpdateStatus,
  updateErrorText,
  updateStatusQuery,
  waitForVersion,
} from "@/lib/api/update";
import { type TFunction, useT } from "@/lib/i18n";
import { toast, toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Where the self-update stands for the UI: nothing yet, the download being asked for, the
 * release on its way down, in place and waiting for a restart, the restart under way, or failed.
 */
export type SelfUpdatePhase =
  | "idle"
  | "starting"
  | "downloading"
  | "ready"
  | "restarting"
  | "error";

export interface SelfUpdate {
  /** The server's answer; undefined until it is in, and never asked of a server in a container. */
  status: UpdateStatus | undefined;
  /** This server can download and install `target` itself. */
  available: boolean;
  /** The newer release the update check found. */
  target: string;
  phase: SelfUpdatePhase;
  /** Why it failed, while `phase` is error. */
  error?: string;
  /** Starts the download (or, after a failure, starts it again). */
  start: () => void;
  /** Restarts the server on the release in place, then reloads the page once it is back. */
  restart: () => void;
  /** Asks first, then restarts (the sidebar button, where a stray click should not restart). */
  confirmRestart: () => void;
}

const READY_TOAST_ID = "update-ready";
const RESTART_TOAST_ID = "update-restart";

/**
 * The self-update for the update notice and dialog. The server is asked only when it runs
 * outside a container and a newer release is known; an older server without the endpoint answers
 * 404, which reads as "cannot update itself", so the dialog shows the manual steps.
 */
export function useSelfUpdateController({
  target,
  server,
}: {
  target: string;
  server: VersionResponse | undefined;
}): SelfUpdate {
  const { t } = useT();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const enabled = Boolean(target && server && !server.docker);
  const { data: status } = useQuery(updateStatusQuery(enabled));
  // The restart is the page's own: the server is down for part of it and cannot report it.
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | undefined>();
  const tRef = useRef(t);
  tRef.current = t;

  const begin = useMutation({
    mutationFn: () => startUpdate(target),
    onSuccess: (next) => queryClient.setQueryData(queryKeys.update, next),
    onError: (error) => toastError(error, tRef.current),
  });

  const restart = useCallback(() => {
    toast.dismiss(READY_TOAST_ID);
    setRestartError(undefined);
    setRestarting(true);
    // The server is down for a moment, so the page says what is going on until it reloads.
    const progress = toast.loading(
      tRef.current("shell.update.restartingToast", { latest: target }),
      { id: RESTART_TOAST_ID },
    );
    restartForUpdate()
      .then(() => waitForVersion(target))
      .then(
        () => window.location.reload(),
        (error: unknown) => {
          setRestarting(false);
          if (error instanceof Error && error.message === "timeout") {
            const message = tRef.current("shell.update.restartTimeout");
            setRestartError(message);
            toast.update(progress, { type: "error", title: message });
            return;
          }
          toast.dismiss(progress);
          toastError(error, tRef.current);
          void queryClient.invalidateQueries({ queryKey: queryKeys.update });
        },
      );
  }, [queryClient, target]);

  const confirmRestart = useCallback(() => {
    void confirm({
      title: tRef.current("shell.update.restartConfirmTitle", { latest: target }),
      description: tRef.current("shell.update.restartNote"),
      confirmLabel: tRef.current("shell.update.restart"),
    }).then((ok) => {
      if (ok) restart();
    });
  }, [confirm, restart, target]);

  const phase: SelfUpdatePhase = restarting
    ? "restarting"
    : restartError
      ? "error"
      : begin.isPending
        ? "starting"
        : (status?.state ?? "idle");

  // One toast when this page's download finishes, with the restart one click away.
  const previous = useRef(phase);
  useEffect(() => {
    const was = previous.current;
    previous.current = phase;
    if (phase !== "ready" || (was !== "downloading" && was !== "starting")) return;
    toast.success(tRef.current("shell.update.readyToast", { latest: target }), {
      id: READY_TOAST_ID,
      duration: 12_000,
      background: true,
      action: { label: tRef.current("shell.update.restart"), onClick: restart },
    });
  }, [phase, restart, target]);

  return useMemo(
    () => ({
      status,
      available: Boolean(enabled && status?.supported),
      target,
      phase,
      error: restartError ?? (status ? updateErrorText(status, t) : undefined),
      start: () => {
        setRestartError(undefined);
        begin.mutate();
      },
      restart,
      confirmRestart,
    }),
    [status, enabled, target, phase, restartError, begin, restart, confirmRestart, t],
  );
}

const RING_RADIUS = 14;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/**
 * The update's state as one 16 px glyph in a 32 px round button: a
 * download arrow with a dot while a release waits, the arrow inside a ring that fills while it
 * downloads, a restart arrow with a tick once it is in place, a spinner while the server
 * restarts, and a warning after a failure.
 */
export function UpdateStatusIcon({
  phase,
  progress,
}: {
  phase: SelfUpdatePhase;
  progress?: number;
}): JSX.Element {
  if (phase === "restarting" || phase === "starting") {
    return <Spinner aria-hidden="true" className="size-4" />;
  }
  if (phase === "error")
    return <HugeiconsIcon aria-hidden="true" className="size-4" icon={Alert02Icon} />;
  if (phase === "ready") {
    return (
      <span aria-hidden="true" className="relative grid size-4 place-items-center">
        <HugeiconsIcon className="size-4" icon={ReloadIcon} />
        <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-background outline-2 outline-background">
          <HugeiconsIcon className="size-2" icon={Tick02Icon} strokeWidth={3} />
        </span>
      </span>
    );
  }
  if (phase === "downloading") {
    const offset = RING_LENGTH * (1 - Math.min(100, Math.max(0, progress ?? 0)) / 100);
    return (
      <span aria-hidden="true" className="relative grid size-8 place-items-center">
        <svg
          aria-hidden="true"
          className="absolute inset-0 size-full -rotate-90"
          viewBox="0 0 32 32"
        >
          <circle
            cx="16"
            cy="16"
            fill="none"
            r={RING_RADIUS}
            stroke="currentColor"
            strokeOpacity={0.22}
            strokeWidth={1.5}
          />
          <circle
            className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
            cx="16"
            cy="16"
            fill="none"
            r={RING_RADIUS}
            stroke="currentColor"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={offset}
            strokeLinecap="round"
            strokeWidth={1.5}
          />
        </svg>
        <HugeiconsIcon className="size-4" icon={Download04Icon} />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="relative grid size-4 place-items-center">
      <HugeiconsIcon className="size-4" icon={Download04Icon} />
      <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warning outline-2 outline-background" />
    </span>
  );
}

/** What the update button does and says in each phase. */
export function updateButtonAction(
  update: SelfUpdate,
  t: TFunction,
): { label: string; run?: () => void } {
  switch (update.phase) {
    case "downloading":
      return {
        label:
          update.status?.progress === undefined
            ? t("shell.update.downloading")
            : t("shell.update.statusDownloading", { percent: update.status.progress }),
      };
    case "starting":
      return { label: t("shell.update.downloading") };
    case "ready":
      return { label: t("shell.update.restart"), run: update.confirmRestart };
    case "restarting":
      return { label: t("shell.update.restarting") };
    case "error":
      return { label: t("shell.update.retry"), run: update.start };
    default:
      return { label: t("shell.update.download"), run: update.start };
  }
}

/**
 * The round 32 px status button at the end of the sidebar's update card: it downloads the
 * release, fills a ring while it does, then asks to restart on it.
 */
export function UpdateStatusButton({
  update,
  className,
}: {
  update: SelfUpdate;
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const action = updateButtonAction(update, t);
  const button = (
    <button
      aria-disabled={action.run ? undefined : true}
      aria-label={action.label}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-control-surface text-sidebar-foreground transition-colors focus-outline",
        action.run ? "cursor-pointer hover:bg-sidebar-row-hover" : "cursor-default",
        update.phase === "error" && "text-destructive-foreground",
        className,
      )}
      data-phase={update.phase}
      data-slot="update-status-button"
      onClick={() => action.run?.()}
      type="button"
    >
      <UpdateStatusIcon phase={update.phase} progress={update.status?.progress} />
    </button>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{action.label}</TooltipPopup>
    </Tooltip>
  );
}
