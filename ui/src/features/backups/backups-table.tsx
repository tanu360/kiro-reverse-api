import { DownloadIcon, EllipsisVerticalIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { type JSX, type ReactNode, useMemo } from "react";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { BackupEntry } from "@/lib/api/types";
import { formatBytes, formatDateTime, formatRelativeTime } from "@/lib/format";
import { type TFunction, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { accountsCell, kindLabel, kindTone, noteText } from "./backup-model";

export interface BackupRowActions {
  onDownload: (entry: BackupEntry) => void;
  onRestore: (entry: BackupEntry) => void;
  onDelete: (entry: BackupEntry) => void;
  /** Rows with a request in flight; their actions are disabled. */
  busyIds: ReadonlySet<string>;
}

/** Text with a hover/focus tooltip; the hint is also part of the accessible name. */
function HintText({
  children,
  hint,
  label,
  className,
}: {
  children: ReactNode;
  hint: string;
  label: string;
  className?: string;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`${label}. ${hint}`}
        className={cn(
          "cursor-default rounded-sm text-left underline decoration-muted-foreground/50 decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
        type="button"
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{hint}</TooltipPopup>
    </Tooltip>
  );
}

function TimeCell({ entry }: { entry: BackupEntry }): JSX.Element {
  const { lang } = useT("backups");
  const absolute = formatDateTime(entry.createdAt, lang);
  return (
    <HintText
      className="whitespace-nowrap no-underline tabular-nums"
      hint={formatRelativeTime(entry.createdAt, lang)}
      label={absolute}
    >
      <time dateTime={new Date(entry.createdAt * 1000).toISOString()}>{absolute}</time>
    </HintText>
  );
}

function KindBadge({ kind, t }: { kind: string; t: TFunction }): JSX.Element {
  const tone = kindTone(kind);
  return (
    <Badge data-tone={tone} variant={tone}>
      {kindLabel(kind, t)}
    </Badge>
  );
}

function AccountsCell({ entry, t }: { entry: BackupEntry; t: TFunction }): JSX.Element {
  const { text, hint } = accountsCell(entry, t);
  if (!hint) return <span className="tabular-nums">{text}</span>;
  return (
    <HintText className="tabular-nums" hint={hint} label={text}>
      {text}
    </HintText>
  );
}

function RowButtons({
  entry,
  actions,
}: {
  entry: BackupEntry;
  actions: BackupRowActions;
}): JSX.Element {
  const { t } = useT("backups");
  const busy = actions.busyIds.has(entry.id);
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              disabled={busy}
              onClick={() => actions.onDownload(entry)}
              size="xs"
              variant="outline"
            />
          }
        >
          <DownloadIcon aria-hidden="true" />
          {t("download")}
        </TooltipTrigger>
        <TooltipPopup className="max-w-64">{t("downloadHint")}</TooltipPopup>
      </Tooltip>
      <Button
        disabled={busy}
        onClick={() => actions.onRestore(entry)}
        size="xs"
        variant="secondary"
      >
        <RotateCcwIcon aria-hidden="true" />
        {t("restore")}
      </Button>
      <Button
        disabled={busy}
        onClick={() => actions.onDelete(entry)}
        size="xs"
        variant="destructive-outline"
      >
        <Trash2Icon aria-hidden="true" />
        {t("delete")}
      </Button>
    </div>
  );
}

function RowMenu({
  entry,
  actions,
  label,
}: {
  entry: BackupEntry;
  actions: BackupRowActions;
  label: string;
}): JSX.Element {
  const { t } = useT("backups");
  const busy = actions.busyIds.has(entry.id);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label={label}
            className="size-10"
            disabled={busy}
            size="icon"
            variant="ghost"
          />
        }
      >
        <EllipsisVerticalIcon aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-44">
        <MenuItem onClick={() => actions.onDownload(entry)}>
          <DownloadIcon aria-hidden="true" />
          {t("download")}
        </MenuItem>
        <MenuItem onClick={() => actions.onRestore(entry)}>
          <RotateCcwIcon aria-hidden="true" />
          {t("restore")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => actions.onDelete(entry)} variant="destructive">
          <Trash2Icon aria-hidden="true" />
          {t("delete")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function MobileCard({
  entry,
  actions,
}: {
  entry: BackupEntry;
  actions: BackupRowActions;
}): JSX.Element {
  const { t, lang } = useT("backups");
  const mask = useMaskText();
  const time = formatDateTime(entry.createdAt, lang);
  return (
    <Card className="flex-row items-start gap-3 p-3 pe-1.5" data-slot="backup-card">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <TimeCell entry={entry} />
          <KindBadge kind={entry.kind} t={t} />
        </div>
        <p className="break-words text-muted-foreground text-sm">{noteText(entry, t, mask)}</p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
          <span>
            {t("accountsInBackup")}: <AccountsCell entry={entry} t={t} />
          </span>
          <span className="tabular-nums">{formatBytes(entry.size, lang)}</span>
        </p>
      </div>
      <RowMenu actions={actions} entry={entry} label={t("rowActions", { time })} />
    </Card>
  );
}

export function BackupsTable({
  rows,
  loading,
  emptyState,
  actions,
}: {
  rows: BackupEntry[];
  loading: boolean;
  emptyState: ReactNode;
  actions: BackupRowActions;
}): JSX.Element {
  const { t, lang } = useT("backups");
  const mask = useMaskText();

  const columns = useMemo<DataTableColumn<BackupEntry>[]>(
    () => [
      { id: "time", header: t("time"), cell: (entry) => <TimeCell entry={entry} /> },
      { id: "kind", header: t("kind"), cell: (entry) => <KindBadge kind={entry.kind} t={t} /> },
      {
        id: "note",
        header: t("note"),
        className: "min-w-48 max-w-96 whitespace-normal break-words leading-snug",
        cell: (entry) => noteText(entry, t, mask),
      },
      {
        id: "accounts",
        header: t("accountsInBackup"),
        align: "end",
        cell: (entry) => <AccountsCell entry={entry} t={t} />,
      },
      {
        id: "size",
        header: t("size"),
        align: "end",
        className: "whitespace-nowrap tabular-nums text-muted-foreground",
        cell: (entry) => formatBytes(entry.size, lang),
      },
      {
        id: "actions",
        header: <span className="sr-only">{t("common:table.actions")}</span>,
        align: "end",
        cell: (entry) => <RowButtons actions={actions} entry={entry} />,
      },
    ],
    [t, lang, mask, actions],
  );

  return (
    <DataTable
      caption={t("list.caption")}
      columns={columns}
      data={rows}
      emptyState={emptyState}
      getRowId={(entry) => entry.id}
      loading={loading}
      renderMobileCard={(entry) => <MobileCard actions={actions} entry={entry} />}
    />
  );
}
