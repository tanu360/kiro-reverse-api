import { ArchiveIcon, FileUpIcon, PlusIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ChangeEvent,
  type JSX,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader, RefreshButton } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import {
  backupsQuery,
  createBackup,
  deleteBackup,
  downloadBackup,
  restoreBackup,
  restoreBackupUpload,
} from "@/lib/api/backups";
import { isApiError } from "@/lib/api/errors";
import { queryKeys } from "@/lib/api/query-keys";
import type { BackupEntry } from "@/lib/api/types";
import { clearSession } from "@/lib/auth/session";
import { saveBlob } from "@/lib/download";
import { useT } from "@/lib/i18n";
import { toast, toastError } from "@/lib/toast";
import { isNotABackupMessage, MAX_UPLOAD_BYTES, manualNote } from "./backup-model";
import { type BackupRowActions, BackupsTable, ROW_FOCUS_ATTR } from "./backups-table";
import { ScheduleCard } from "./schedule-card";

/**
 * Tracks which rows have a request in flight. A second action on a busy row is ignored: the
 * controls stay focusable while busy, so they can still be pressed.
 */
function useBusyRows(): {
  busyIds: ReadonlySet<string>;
  isBusy: (id: string) => boolean;
  run: (id: string, task: () => Promise<void>) => Promise<void>;
} {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const busyRef = useRef(new Set<string>());
  const isBusy = useCallback((id: string) => busyRef.current.has(id), []);
  const run = useCallback(async (id: string, task: () => Promise<void>) => {
    if (busyRef.current.has(id)) return;
    busyRef.current.add(id);
    setBusyIds((current) => new Set(current).add(id));
    try {
      await task();
    } finally {
      busyRef.current.delete(id);
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, []);
  return { busyIds, isBusy, run };
}

// Header buttons stay focusable while busy (aria-disabled, not disabled): a natively disabled
// button drops keyboard focus to <body>. Their click handlers ignore presses while busy.
const BUSY_BUTTON = "aria-disabled:pointer-events-none aria-disabled:opacity-64";

/** A deleted row, and where it was, until focus has moved on from it. */
interface Refocus {
  id: string;
  index: number;
}

export function BackupsPage(): JSX.Element {
  const { t } = useT("backups");
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const list = useQuery(backupsQuery());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const { busyIds, isBusy, run } = useBusyRows();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [refocus, setRefocus] = useState<Refocus | null>(null);

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.backups.all }),
    [queryClient],
  );

  const createPendingRef = useRef(false);
  const create = useMutation({
    mutationFn: () => createBackup({ kind: "manual", note: manualNote(new Date()) }),
    onSuccess: () => {
      toast.success(t("created"));
      void invalidate();
    },
    onError: (error) => toastError(error, t),
    onSettled: () => {
      createPendingRef.current = false;
    },
  });
  const startCreate = () => {
    if (createPendingRef.current) return;
    createPendingRef.current = true;
    create.mutate();
  };

  // The server revoked every admin session, this one included. The root route sends the
  // browser to sign-in once the session is cleared.
  const finishRestore = useCallback(() => {
    toast.success(t("restored"));
    clearSession("restored");
  }, [t]);

  const restoreConfirm = useCallback(
    (title: string) =>
      confirm({
        title,
        description: t("restoreBody"),
        confirmLabel: t("restore"),
        variant: "danger",
      }),
    [confirm, t],
  );

  const actions = useMemo<BackupRowActions>(
    () => ({
      busyIds,
      onDownload: (entry: BackupEntry) =>
        void run(entry.id, async () => {
          try {
            const { blob, filename } = await downloadBackup(entry.id);
            saveBlob(blob, filename || `kiro-backup-${entry.id}.json`);
            // The warning was only a hover tooltip; this way touch users see it too.
            toast.success(t("downloaded"), { description: t("downloadHint") });
          } catch (error) {
            toastError(error, t);
          }
        }),
      onRestore: (entry: BackupEntry) =>
        void (async () => {
          if (isBusy(entry.id)) return;
          if (!(await restoreConfirm(t("confirmRestore")))) return;
          await run(entry.id, async () => {
            try {
              await restoreBackup(entry.id);
            } catch (error) {
              toastError(error, t);
              return;
            }
            finishRestore();
          });
        })(),
      onDelete: (entry: BackupEntry) =>
        void (async () => {
          if (isBusy(entry.id)) return;
          const ok = await confirm({
            title: t("confirmDelete"),
            description: t("deleteBody"),
            confirmLabel: t("delete"),
            variant: "danger",
          });
          if (!ok) return;
          await run(entry.id, async () => {
            try {
              await deleteBackup(entry.id);
            } catch (error) {
              toastError(error, t);
              return;
            }
            toast.success(t("deleted"));
            const index = (list.data ?? []).findIndex((row) => row.id === entry.id);
            setRefocus({ id: entry.id, index: Math.max(0, index) });
            await invalidate();
          });
        })(),
    }),
    [busyIds, isBusy, run, t, confirm, restoreConfirm, finishRestore, invalidate, list.data],
  );

  const rows = list.data ?? [];

  // After a delete, focus goes to the row that took the deleted one's place (or the one above
  // it, or the empty state's Create backup), not to <body> with the removed row.
  useLayoutEffect(() => {
    if (!refocus) return;
    if (rows.some((row) => row.id === refocus.id)) return;
    const container = listRef.current;
    if (!container) return;
    const next = rows[Math.min(refocus.index, rows.length - 1)];
    const candidates = Array.from(container.querySelectorAll<HTMLElement>(`[${ROW_FOCUS_ATTR}]`));
    const target = next
      ? candidates.find((element) => element.getAttribute(ROW_FOCUS_ATTR) === next.id)
      : container.querySelector<HTMLElement>("[data-empty-focus]");
    target?.focus();
    setRefocus(null);
  }, [refocus, rows]);

  const uploadError = (error: unknown) => {
    if (isApiError(error) && isNotABackupMessage(error.serverMessage)) {
      toast.error(t("notABackup"), {
        description: t("notABackupBody", { detail: error.serverMessage.trim() }),
      });
      return;
    }
    toastError(error, t);
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset right away so picking the same file again fires another change.
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error(t("fileTooLarge"));
      return;
    }
    if (!(await restoreConfirm(t("confirmUpload")))) return;
    setUploading(true);
    try {
      await restoreBackupUpload(file);
    } catch (error) {
      uploadError(error);
      return;
    } finally {
      setUploading(false);
    }
    finishRestore();
  };

  const createButton = (inEmptyState: boolean) => (
    <Button
      aria-busy={create.isPending || undefined}
      aria-disabled={create.isPending || undefined}
      className={BUSY_BUTTON}
      data-empty-focus={inEmptyState ? "" : undefined}
      onClick={startCreate}
    >
      {create.isPending ? (
        <Spinner aria-hidden="true" />
      ) : (
        <HugeiconsIcon icon={PlusIcon} aria-hidden="true" />
      )}
      {create.isPending ? t("creating") : t("create")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <PageHeader
        actions={
          <>
            <input
              accept="application/json,.json"
              className="hidden"
              data-testid="backup-upload-input"
              onChange={(event) => void onFileChange(event)}
              ref={fileInputRef}
              type="file"
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-busy={uploading || undefined}
                    aria-disabled={uploading || undefined}
                    className={BUSY_BUTTON}
                    onClick={() => {
                      if (!uploading) fileInputRef.current?.click();
                    }}
                    variant="outline"
                  />
                }
              >
                {uploading ? (
                  <Spinner aria-hidden="true" />
                ) : (
                  <HugeiconsIcon icon={FileUpIcon} aria-hidden="true" />
                )}
                {t("upload")}
              </TooltipTrigger>
              <TooltipPopup>{t("uploadHint")}</TooltipPopup>
            </Tooltip>
            <RefreshButton
              fetching={list.isFetching && !list.isPending}
              onRefresh={() => void invalidate()}
            />
            {createButton(false)}
          </>
        }
        description={t("description")}
        title={t("title")}
      />

      <ScheduleCard />

      <SectionCard id="backup-list" title={t("list.title")}>
        {list.isError && !list.data ? (
          <ErrorState
            error={list.error}
            onRetry={() => void list.refetch()}
            title={t("loadError")}
          />
        ) : (
          <div ref={listRef}>
            <BackupsTable
              actions={actions}
              emptyState={
                <EmptyState
                  action={createButton(true)}
                  description={t("emptyBody")}
                  icon={ArchiveIcon}
                  title={t("empty")}
                />
              }
              loading={list.isPending}
              rows={rows}
            />
          </div>
        )}
      </SectionCard>
    </div>
  );
}
