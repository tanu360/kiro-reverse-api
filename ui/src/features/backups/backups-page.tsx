import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon, FileUpIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { type ChangeEvent, type JSX, useCallback, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader } from "@/components/shared/page-header";
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
import { queryKeys } from "@/lib/api/query-keys";
import type { BackupEntry } from "@/lib/api/types";
import { clearSession } from "@/lib/auth/session";
import { saveBlob } from "@/lib/download";
import { useT } from "@/lib/i18n";
import { toast, toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { MAX_UPLOAD_BYTES, manualNote } from "./backup-model";
import { type BackupRowActions, BackupsTable } from "./backups-table";
import { ScheduleCard } from "./schedule-card";

/** Tracks which rows have a request in flight. */
function useBusyRows(): {
  busyIds: ReadonlySet<string>;
  run: (id: string, task: () => Promise<void>) => Promise<void>;
} {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const run = useCallback(async (id: string, task: () => Promise<void>) => {
    setBusyIds((current) => new Set(current).add(id));
    try {
      await task();
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, []);
  return { busyIds, run };
}

export function BackupsPage(): JSX.Element {
  const { t } = useT("backups");
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const list = useQuery(backupsQuery());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const { busyIds, run } = useBusyRows();

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.backups.all }),
    [queryClient],
  );

  const create = useMutation({
    mutationFn: () => createBackup({ kind: "manual", note: manualNote(new Date()) }),
    onSuccess: () => {
      toast.success(t("created"));
      void invalidate();
    },
    onError: (error) => toastError(error, t),
  });

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
          } catch (error) {
            toastError(error, t);
          }
        }),
      onRestore: (entry: BackupEntry) =>
        void (async () => {
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
            await invalidate();
          });
        })(),
    }),
    [busyIds, run, t, confirm, restoreConfirm, finishRestore, invalidate],
  );

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
      toastError(error, t);
      return;
    } finally {
      setUploading(false);
    }
    finishRestore();
  };

  const rows = list.data ?? [];
  const createButton = (
    <Button disabled={create.isPending} onClick={() => create.mutate()}>
      {create.isPending ? <Spinner aria-hidden="true" /> : <PlusIcon aria-hidden="true" />}
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
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                    variant="outline"
                  />
                }
              >
                {uploading ? <Spinner aria-hidden="true" /> : <FileUpIcon aria-hidden="true" />}
                {t("upload")}
              </TooltipTrigger>
              <TooltipPopup>{t("uploadHint")}</TooltipPopup>
            </Tooltip>
            <Button disabled={list.isFetching} onClick={() => void invalidate()} variant="outline">
              <RefreshCwIcon
                aria-hidden="true"
                className={cn(list.isFetching && !list.isPending && "animate-spin")}
              />
              {t("common:actions.refresh")}
            </Button>
            {createButton}
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
          <BackupsTable
            actions={actions}
            emptyState={
              <EmptyState
                action={createButton}
                description={t("emptyBody")}
                icon={ArchiveIcon}
                title={t("empty")}
              />
            }
            loading={list.isPending}
            rows={rows}
          />
        )}
      </SectionCard>
    </div>
  );
}
