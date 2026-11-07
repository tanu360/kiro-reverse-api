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
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader, RefreshButton } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
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
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { toast, toastError } from "@/lib/toast";
import { isNotABackupMessage, listMeta, MAX_UPLOAD_BYTES, manualNote } from "./backup-model";
import {
  type BackupAction,
  type BackupRowActions,
  BackupsTable,
  ROW_FOCUS_ATTR,
} from "./backups-table";
import { ScheduleCard } from "./schedule-card";

const PAGE_SIZE = 25;

/**
 * Tracks which rows have a request in flight, and which action. A second action on a busy row
 * is ignored: the controls stay focusable while busy, so they can still be pressed.
 */
function useBusyRows(): {
  busy: ReadonlyMap<string, BackupAction>;
  isBusy: (id: string) => boolean;
  run: (id: string, action: BackupAction, task: () => Promise<void>) => Promise<void>;
} {
  const [busy, setBusy] = useState<ReadonlyMap<string, BackupAction>>(() => new Map());
  const busyRef = useRef(new Set<string>());
  const isBusy = useCallback((id: string) => busyRef.current.has(id), []);
  const run = useCallback(async (id: string, action: BackupAction, task: () => Promise<void>) => {
    if (busyRef.current.has(id)) return;
    busyRef.current.add(id);
    setBusy((current) => new Map(current).set(id, action));
    try {
      await task();
    } finally {
      busyRef.current.delete(id);
      setBusy((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    }
  }, []);
  return { busy, isBusy, run };
}

/**
 * Focuses the first of `elements` that can take focus. The list renders both its table and its
 * cards and CSS shows one, so the hidden layout's copy of a control refuses focus.
 */
function focusFirstShown(elements: readonly HTMLElement[]): void {
  for (const element of elements) {
    element.focus();
    if (document.activeElement === element) return;
  }
}

/** A deleted row, and where it was, until focus has moved on from it. */
interface Refocus {
  id: string;
  index: number;
}

export function BackupsPage(): JSX.Element {
  const { t, lang } = useT("backups");
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const list = useQuery(backupsQuery());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const { busy, isBusy, run } = useBusyRows();
  const listRef = useRef<HTMLDivElement | null>(null);
  const createRef = useRef<HTMLButtonElement | null>(null);
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
    (title: string, target?: string) =>
      confirm({
        title,
        target,
        description: t("restoreBody"),
        confirmLabel: t("restore"),
        variant: "danger",
      }),
    [confirm, t],
  );

  const actions = useMemo<BackupRowActions>(
    () => ({
      busy,
      onDownload: (entry: BackupEntry) =>
        void run(entry.id, "download", async () => {
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
          const time = formatDateTime(entry.createdAt, lang);
          if (!(await restoreConfirm(t("confirmRestore", { time }), time))) return;
          await run(entry.id, "restore", async () => {
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
          const time = formatDateTime(entry.createdAt, lang);
          const ok = await confirm({
            title: t("confirmDelete", { time }),
            target: time,
            description: t("deleteBody"),
            confirmLabel: t("delete"),
            variant: "danger",
          });
          if (!ok) return;
          await run(entry.id, "delete", async () => {
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
    [busy, isBusy, run, t, lang, confirm, restoreConfirm, finishRestore, invalidate, list.data],
  );

  const rows = list.data ?? [];
  // 25 rows a page, as on Accounts; the pager shows only past one page. A page that empties
  // (its last backup deleted) falls back to the new last page.
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = useMemo(
    () => rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [rows, currentPage],
  );

  // After a delete, focus goes to the row that took the deleted one's place (or the one above
  // it, or the card header's Create backup once the list is empty), not to <body> with the
  // removed row.
  useLayoutEffect(() => {
    if (!refocus) return;
    if (rows.some((row) => row.id === refocus.id)) return;
    const container = listRef.current;
    if (!container) return;
    const next = rows[Math.min(refocus.index, rows.length - 1)];
    const targets = next
      ? Array.from(container.querySelectorAll<HTMLElement>(`[${ROW_FOCUS_ATTR}]`)).filter(
          (element) => element.getAttribute(ROW_FOCUS_ATTR) === next.id,
        )
      : createRef.current
        ? [createRef.current]
        : [];
    focusFirstShown(targets);
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
    if (!(await restoreConfirm(t("confirmUpload", { name: file.name }), file.name))) return;
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
                    loading={uploading}
                    onClick={() => fileInputRef.current?.click()}
                    variant="secondary"
                  />
                }
              >
                <HugeiconsIcon icon={FileUpIcon} aria-hidden="true" />
                {t("upload")}
              </TooltipTrigger>
              <TooltipPopup>{t("uploadHint")}</TooltipPopup>
            </Tooltip>
          </>
        }
        description={t("description")}
        title={t("title")}
      />

      <ScheduleCard />

      <SectionCard
        actions={
          <>
            <RefreshButton
              fetching={list.isFetching && !list.isPending}
              onRefresh={() => void invalidate()}
              variant="icon"
            />
            {/* The page's primary action at the page's button size, as Add account. */}
            <Button loading={create.isPending} onClick={startCreate} ref={createRef}>
              <HugeiconsIcon icon={PlusIcon} aria-hidden="true" />
              {t("create")}
            </Button>
          </>
        }
        icon={ArchiveIcon}
        id="backup-list"
        // Nothing to count with no backups: the empty state under it says so.
        meta={list.data && rows.length > 0 ? listMeta(rows, t, lang) : undefined}
        slim
        title={t("list.title")}
      >
        {list.isError && !list.data ? (
          <ErrorState
            compact
            error={list.error}
            onRetry={() => void list.refetch()}
            title={t("loadError")}
          />
        ) : (
          <div className="min-w-0" ref={listRef}>
            <BackupsTable
              actions={actions}
              emptyState={
                <EmptyState
                  description={t("emptyBody")}
                  icon={ArchiveIcon}
                  inCard
                  title={t("empty")}
                />
              }
              loading={list.isPending}
              pageSize={PAGE_SIZE}
              rows={pageRows}
            />
          </div>
        )}
      </SectionCard>
      {/* The pager sits under the card, as on Accounts. */}
      {rows.length > PAGE_SIZE ? (
        <DataTablePagination
          onPageChange={(next) => {
            setPage(next);
            // The next page starts at its first backup, not where the last one was scrolled.
            document.getElementById("backup-list")?.scrollIntoView({ block: "start" });
          }}
          page={currentPage}
          pageSize={PAGE_SIZE}
          total={rows.length}
        />
      ) : null}
    </div>
  );
}
