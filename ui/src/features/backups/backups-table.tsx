import {
  ArchiveIcon,
  CalendarClockIcon,
  Delete02Icon,
  Download01Icon,
  EllipsisVerticalIcon,
  HandIcon,
  HistoryIcon,
  SaveIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type JSX, type ReactNode, useMemo } from "react";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { InfoHint } from "@/components/shared/info-hint";
import { ListCard } from "@/components/shared/list-card";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { BackupEntry } from "@/lib/api/types";
import { EMPTY, formatBytes, formatDateTime } from "@/lib/format";
import { type TFunction, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { accountsCell, kindLabel, kindTone, noteText } from "./backup-model";

export type BackupAction = "download" | "restore" | "delete";

export interface BackupRowActions {
  onDownload: (entry: BackupEntry) => void;
  onRestore: (entry: BackupEntry) => void;
  onDelete: (entry: BackupEntry) => void;
  /**
   * Rows with a request in flight, and which action it is: that button shows the spinner, the
   * row's other actions do nothing but stay focusable.
   */
  busy: ReadonlyMap<string, BackupAction>;
}

/** Marks each row's first action; it takes focus when the row above it is deleted. */
export const ROW_FOCUS_ATTR = "data-row-focus";

function isoTime(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}

/** The date and time on the first line, how long ago on a muted second line. */
function TimeCell({ entry }: { entry: BackupEntry }): JSX.Element {
  const { lang } = useT("backups");
  return (
    <div className="flex flex-col">
      <time className="whitespace-nowrap" dateTime={isoTime(entry.createdAt)}>
        {formatDateTime(entry.createdAt, lang)}
      </time>
      <span className="text-meta text-muted-foreground">
        <RelativeTime value={entry.createdAt} />
      </span>
    </div>
  );
}

const KIND_ICONS: Record<string, IconSvgElement> = {
  manual: HandIcon,
  scheduled: CalendarClockIcon,
  auto: SaveIcon,
  "pre-restore": HistoryIcon,
};

function KindBadge({ kind, t }: { kind: string; t: TFunction }): JSX.Element {
  const tone = kindTone(kind);
  return (
    <Badge data-tone={tone} icon={KIND_ICONS[kind] ?? ArchiveIcon} iconStyle="line" tone={tone}>
      {kindLabel(kind, t)}
    </Badge>
  );
}

/** The account count; a rollback point's count opens what it saved before the restore. */
function AccountsCell({ entry, t }: { entry: BackupEntry; t: TFunction }): JSX.Element {
  const { lang } = useT();
  const { text, hint } = accountsCell(entry, t, lang);
  if (hint) return <InfoHint hint={hint}>{text}</InfoHint>;
  return <span className={text === EMPTY ? "text-muted-foreground" : undefined}>{text}</span>;
}

type Mask = (text?: string) => string;

/** The note, or a muted dash when there is none. */
function NoteCell({ entry, t, mask }: { entry: BackupEntry; t: TFunction; mask: Mask }): ReactNode {
  const note = noteText(entry, t, mask);
  return note === EMPTY ? <span className="text-muted-foreground">{EMPTY}</span> : note;
}

/** The card's row menu: every action of the row, one tap away. */
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
  const busy = actions.busy.has(entry.id);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-busy={busy || undefined}
            aria-label={label}
            data-row-focus={entry.id}
            size="icon"
            variant="quiet"
          />
        }
      >
        <HugeiconsIcon icon={EllipsisVerticalIcon} aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem disabled={busy} onClick={() => actions.onDownload(entry)}>
          <HugeiconsIcon icon={Download01Icon} aria-hidden="true" />
          {t("download")}
        </MenuItem>
        <MenuItem disabled={busy} onClick={() => actions.onRestore(entry)}>
          <HugeiconsIcon icon={Undo02Icon} aria-hidden="true" />
          {t("restore")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={busy} onClick={() => actions.onDelete(entry)} variant="destructive">
          <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
          {t("delete")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * One quiet icon button with its name in a tooltip. While its row is busy it stays focusable:
 * the running action shows the spinner, the others are inert.
 */
function RowIconButton({
  label,
  hint,
  icon: Icon,
  running,
  blocked,
  destructive = false,
  focusId,
  onClick,
}: {
  label: string;
  hint?: string;
  icon: IconSvgElement;
  running: boolean;
  blocked: boolean;
  destructive?: boolean;
  focusId?: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-disabled={blocked || undefined}
            aria-label={label}
            data-row-focus={focusId}
            loading={running}
            onClick={() => {
              if (!blocked) onClick();
            }}
            size="icon"
            variant={destructive ? "quiet-destructive" : "quiet"}
          />
        }
      >
        <HugeiconsIcon icon={Icon} aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup className="max-w-64">
        {hint ? (
          <>
            <span className="font-medium">{label}</span>. {hint}
          </>
        ) : (
          label
        )}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Table row actions as three quiet icon buttons, quieter than bordered text buttons. */
function RowActions({
  entry,
  actions,
}: {
  entry: BackupEntry;
  actions: BackupRowActions;
}): JSX.Element {
  const { t } = useT("backups");
  const running = actions.busy.get(entry.id);
  const blocked = running !== undefined;
  return (
    <div className="flex items-center justify-end gap-0.5">
      <RowIconButton
        blocked={blocked}
        focusId={entry.id}
        hint={t("downloadHint")}
        icon={Download01Icon}
        label={t("download")}
        onClick={() => actions.onDownload(entry)}
        running={running === "download"}
      />
      <RowIconButton
        blocked={blocked}
        icon={Undo02Icon}
        label={t("restore")}
        onClick={() => actions.onRestore(entry)}
        running={running === "restore"}
      />
      <RowIconButton
        blocked={blocked}
        destructive
        icon={Delete02Icon}
        label={t("delete")}
        onClick={() => actions.onDelete(entry)}
        running={running === "delete"}
      />
    </div>
  );
}

/** A backup as a card: time and menu, how long ago and the size, the note, kind and accounts. */
function BackupCard({
  entry,
  actions,
}: {
  entry: BackupEntry;
  actions: BackupRowActions;
}): JSX.Element {
  const { t, lang } = useT("backups");
  const mask = useMaskText();
  const time = formatDateTime(entry.createdAt, lang);
  const note = noteText(entry, t, mask);
  return (
    <ListCard
      action={<RowMenu actions={actions} entry={entry} label={t("rowActions", { time })} />}
      footer={
        // One line: a long count wraps in its own column, so every card's badge sits bottom-left.
        <div className="flex items-end justify-between gap-3">
          <KindBadge kind={entry.kind} t={t} />
          <span className="min-w-0 text-end text-meta text-muted-foreground">
            {t("accountsInBackup")}: <AccountsCell entry={entry} t={t} />
          </span>
        </div>
      }
      meta={
        <span className="tabular-nums">
          <RelativeTime value={entry.createdAt} /> · {formatBytes(entry.size, lang)}
        </span>
      }
      title={<time dateTime={isoTime(entry.createdAt)}>{time}</time>}
    >
      {note === EMPTY ? null : <p className="break-words text-muted-foreground text-sm">{note}</p>}
    </ListCard>
  );
}

export function BackupsTable({
  rows,
  loading,
  pageSize,
  emptyState,
  actions,
}: {
  rows: BackupEntry[];
  loading: boolean;
  /** Rows a full page holds, for the loading placeholder. */
  pageSize?: number;
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
        cell: (entry) => <NoteCell entry={entry} mask={mask} t={t} />,
      },
      {
        id: "accounts",
        // The short name until the table has room for the long one (with the size column).
        header: (
          <>
            <span className="@5xl/data-table:hidden">{t("accountsShort")}</span>
            <span className="hidden @5xl/data-table:inline">{t("accountsInBackup")}</span>
          </>
        ),
        align: "end",
        cell: (entry) => <AccountsCell entry={entry} t={t} />,
      },
      {
        // The card's meta has the total; the column joins the table once there is room.
        id: "size",
        header: t("size"),
        align: "end",
        className: "hidden whitespace-nowrap text-muted-foreground @5xl/data-table:table-cell",
        headerClassName: "hidden @5xl/data-table:table-cell",
        cell: (entry) => formatBytes(entry.size, lang),
      },
      {
        id: "actions",
        header: <span className="sr-only">{t("common:table.actions")}</span>,
        align: "end",
        // Pinned to the right edge, so the actions stay in view if a long note widens the
        // table past its card.
        sticky: "end",
        className: "py-1",
        cell: (entry) => <RowActions actions={actions} entry={entry} />,
      },
    ],
    [t, lang, mask, actions],
  );

  return (
    <DataTable
      caption={t("list.caption")}
      cardLayout="grid"
      // Cards on a phone, the table from 42rem as on Accounts and Requests. With the short
      // Accounts header its five columns fit the 744 px a 1024 px window leaves, unscrolled.
      cardsBelow="2xl"
      columns={columns}
      data={rows}
      density="comfortable"
      emptyState={emptyState}
      getRowId={(entry) => entry.id}
      inset
      loading={loading}
      pageSize={pageSize}
      renderCard={(entry) => <BackupCard actions={actions} entry={entry} />}
    />
  );
}
