import {
  ArchiveIcon,
  CircleCheckIcon,
  FileUpIcon,
  PlusIcon,
  XIcon,
} from "@hugeicons/core-free-icons";
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
import { ActionError } from "@/components/shared/action-error";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { NoticeIconButton, NoticeLine } from "@/components/shared/notice-line";
import { PageHeader, RefreshButton } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { CardPanel } from "@/components/ui/card";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { announce } from "@/lib/announce";
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
import { formatBytes, formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { isNotABackupMessage, listMeta, MAX_UPLOAD_BYTES, manualNote } from "./backup-model";
import {
  type BackupAction,
  type BackupRowActions,
  BackupsTable,
  ROW_FOCUS_ATTR,
} from "./backups-table";
import { ScheduleCard } from "./schedule-card";

/** Ten backups a page, so the saved list stays about a screen tall. */
const PAGE_SIZE = 10;

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

/** A row's first action, in the table and in the cards (CSS shows one). */
function rowFocusTargets(container: HTMLElement | null, id: string): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(`[${ROW_FOCUS_ATTR}]`)).filter(
    (element) => element.getAttribute(ROW_FOCUS_ATTR) === id,
  );
}

/** A deleted row, and where it was, until focus has moved on from it. */
interface Refocus {
  id: string;
  index: number;
}

/** The last action that failed, said at the top of the list card. */
type Failure =
  | { action: "create"; error: unknown }
  | { action: BackupAction; entry: BackupEntry; error: unknown }
  /** `file` is left out when sending it again cannot help (too large, not a backup). */
  | { action: "upload"; file?: File; error: unknown };

/**
 * After a download, one green line: it was downloaded, and the plain-text warning, which the
 * button shows only as a hover tooltip (so touch users see it here). Its alert role reads it out.
 */
function DownloadedNotice({ onDismiss }: { onDismiss: () => void }): JSX.Element {
  const { t } = useT("backups");
  return (
    <NoticeLine
      actions={
        <NoticeIconButton icon={XIcon} label={t("common:actions.close")} onClick={onDismiss} />
      }
      data-testid="backup-downloaded"
      icon={CircleCheckIcon}
      variant="success"
    >
      {t("common:text.joinSentences", { first: t("downloaded"), second: t("downloadHint") })}
    </NoticeLine>
  );
}

export function BackupsPage(): JSX.Element {
  const { t, lang } = useT("backups");
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const list = useQuery(backupsQuery());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadRef = useRef<HTMLButtonElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const { busy, isBusy, run } = useBusyRows();
  const listRef = useRef<HTMLDivElement | null>(null);
  const createRef = useRef<HTMLButtonElement | null>(null);
  const [refocus, setRefocus] = useState<Refocus | null>(null);
  const [page, setPage] = useState(1);
  /*
   * The list shows a result itself (a row comes or goes, the busy button spins) and a screen
   * reader hears it; a download leaves a green line with its warning, and a failure shows at the
   * top of the list card. A restore signs out, so the sign-in page comes next.
   */
  const [failure, setFailure] = useState<Failure | null>(null);
  const failureRef = useRef<HTMLDivElement | null>(null);
  // The backup just downloaded, for its green line.
  const [downloaded, setDownloaded] = useState<string | null>(null);
  /** A new action starts: the last one's notice goes. */
  const clearNotices = useCallback(() => {
    setFailure(null);
    setDownloaded(null);
  }, []);

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.backups.all }),
    [queryClient],
  );

  const createPendingRef = useRef(false);
  // The page shown when Create backup was pressed.
  const createPageRef = useRef(1);
  const create = useMutation({
    mutationFn: () => createBackup({ kind: "manual", note: manualNote(new Date()) }),
    onMutate: clearNotices,
    onSuccess: () => {
      // The new backup is the newest, so it lands at the top of the first page: show it there,
      // unless the user has moved on while it was made (to another page, or into the list).
      // Turning the page then would take their place, and the focused row with it.
      if (!listRef.current?.contains(document.activeElement)) {
        setPage((current) => (current === createPageRef.current ? 1 : current));
      }
      announce(t("created"));
      void invalidate();
    },
    onError: (error) => setFailure({ action: "create", error }),
    onSettled: () => {
      createPendingRef.current = false;
    },
  });
  const startCreate = () => {
    if (createPendingRef.current) return;
    createPendingRef.current = true;
    createPageRef.current = page;
    create.mutate();
  };

  // The server revoked every admin session, this one included. The root route sends the
  // browser to sign-in, which says the backup was restored, once the session is cleared.
  const finishRestore = useCallback(() => {
    clearSession("restored");
  }, []);

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

  // Each row action runs without asking again from Try again: it was confirmed the first time.
  const download = useCallback(
    (entry: BackupEntry) =>
      run(entry.id, "download", async () => {
        clearNotices();
        try {
          const { blob, filename } = await downloadBackup(entry.id);
          saveBlob(blob, filename || `kiro-backup-${entry.id}.json`);
          setDownloaded(entry.id);
        } catch (error) {
          setFailure({ action: "download", entry, error });
        }
      }),
    [run, clearNotices],
  );

  const restoreEntry = useCallback(
    (entry: BackupEntry) =>
      run(entry.id, "restore", async () => {
        clearNotices();
        try {
          await restoreBackup(entry.id);
        } catch (error) {
          setFailure({ action: "restore", entry, error });
          return;
        }
        finishRestore();
      }),
    [run, clearNotices, finishRestore],
  );

  const deleteEntry = useCallback(
    (entry: BackupEntry) =>
      run(entry.id, "delete", async () => {
        clearNotices();
        try {
          await deleteBackup(entry.id);
        } catch (error) {
          setFailure({ action: "delete", entry, error });
          return;
        }
        announce(t("deleted"));
        // The list as it is now: it may have changed while the delete ran.
        const now = queryClient.getQueryData(backupsQuery().queryKey) ?? [];
        const index = now.findIndex((row) => row.id === entry.id);
        setRefocus({ id: entry.id, index: Math.max(0, index) });
        await invalidate();
      }),
    [run, clearNotices, t, invalidate, queryClient],
  );

  const actions = useMemo<BackupRowActions>(
    () => ({
      busy,
      onDownload: (entry: BackupEntry) => void download(entry),
      onRestore: (entry: BackupEntry) =>
        void (async () => {
          if (isBusy(entry.id)) return;
          const time = formatDateTime(entry.createdAt, lang);
          if (!(await restoreConfirm(t("confirmRestore", { time }), time))) return;
          await restoreEntry(entry);
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
          await deleteEntry(entry);
        })(),
    }),
    [busy, isBusy, t, lang, confirm, restoreConfirm, download, restoreEntry, deleteEntry],
  );

  const rows = list.data ?? [];
  // PAGE_SIZE rows a page; the pager shows only past one page. A page that empties
  // (its last backup deleted) falls back to the new last page.
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
      ? rowFocusTargets(container, next.id)
      : createRef.current
        ? [createRef.current]
        : [];
    focusFirstShown(targets);
    setRefocus(null);
  }, [refocus, rows]);

  // A failed action on a backup that has since gone (deleted elsewhere, pruned by a schedule
  // save) has nothing left to retry: its notice goes, and focus in it moves to Create backup.
  useLayoutEffect(() => {
    if (!failure || !("entry" in failure) || !list.data) return;
    if (list.data.some((row) => row.id === failure.entry.id)) return;
    if (failureRef.current?.contains(document.activeElement)) createRef.current?.focus();
    setFailure(null);
  }, [failure, list.data]);

  /** A row's first action; Create backup when the row is on another page or gone. */
  const focusRow = (id: string) =>
    focusFirstShown([
      ...rowFocusTargets(listRef.current, id),
      ...(createRef.current ? [createRef.current] : []),
    ]);

  /**
   * Where focus goes as a failure's notice closes or retries, so it never drops to <body>: the
   * control that ran the action.
   */
  const focusFailure = (current: Failure) => {
    if (current.action === "create") createRef.current?.focus();
    else if (current.action === "upload") uploadRef.current?.focus();
    else focusRow(current.entry.id);
  };

  const emptyState = useMemo(
    () => <EmptyState description={t("emptyBody")} icon={ArchiveIcon} inCard title={t("empty")} />,
    [t],
  );

  const upload = async (file: File) => {
    clearNotices();
    setUploading(true);
    try {
      await restoreBackupUpload(file);
    } catch (error) {
      // A file that is not a backup fails the same way every time: no Try again.
      setFailure(
        isApiError(error) && isNotABackupMessage(error.serverMessage)
          ? {
              action: "upload",
              error: t("notABackupBody", { detail: error.serverMessage.trim() }),
            }
          : { action: "upload", file, error },
      );
      return;
    } finally {
      setUploading(false);
    }
    finishRestore();
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset right away so picking the same file again fires another change.
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      clearNotices();
      setFailure({
        action: "upload",
        error: t("fileTooLarge", { size: formatBytes(file.size, lang) }),
      });
      return;
    }
    if (!(await restoreConfirm(t("confirmUpload", { name: file.name }), file.name))) return;
    await upload(file);
  };

  // Focus moves first, as the notice goes with the retry.
  const retry = (current: Failure) => {
    focusFailure(current);
    switch (current.action) {
      case "create":
        startCreate();
        break;
      case "upload":
        if (current.file) void upload(current.file);
        break;
      case "download":
        void download(current.entry);
        break;
      case "restore":
        void restoreEntry(current.entry);
        break;
      case "delete":
        void deleteEntry(current.entry);
        break;
    }
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
                    ref={uploadRef}
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
          // The page's primary action at the page's button size, as Add account.
          <Button loading={create.isPending} onClick={startCreate} ref={createRef}>
            <HugeiconsIcon icon={PlusIcon} aria-hidden="true" />
            {t("create")}
          </Button>
        }
        cornerAction={
          <RefreshButton
            fetching={list.isFetching && !list.isPending}
            onRefresh={() => void invalidate()}
            variant="icon"
          />
        }
        description={t("list.description")}
        icon={ArchiveIcon}
        id="backup-list"
        // Nothing to count with no backups: the empty state under it says so.
        meta={list.data && rows.length > 0 ? listMeta(rows, t, lang) : undefined}
        slim
        title={t("list.title")}
      >
        {failure ? (
          <CardPanel ref={failureRef}>
            <ActionError
              error={failure.error}
              onDismiss={() => {
                setFailure(null);
                focusFailure(failure);
              }}
              onRetry={
                failure.action === "upload" && !failure.file ? undefined : () => retry(failure)
              }
            />
          </CardPanel>
        ) : null}
        {downloaded ? (
          <CardPanel>
            <DownloadedNotice
              onDismiss={() => {
                setDownloaded(null);
                focusRow(downloaded);
              }}
            />
          </CardPanel>
        ) : null}
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
              emptyState={emptyState}
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
