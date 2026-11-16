import {
  ArchiveIcon,
  CalendarClockIcon,
  Delete02Icon,
  Download01Icon,
  EllipsisVerticalIcon,
  GitMergeIcon,
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
import { TruncatedText } from "@/components/shared/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { BackupEntry } from "@/lib/api/types";
import { dateTimeFormat, EMPTY, formatBytes, formatDateTime } from "@/lib/format";
import { fillNodes, type Lang, type TFunction, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { accountsCell, backupKind, kindLabel, kindTone, noteText } from "./backup-model";

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

/** "Nov 16, 1:14 PM": the date (with the year only when it is not this year's) and the time. */
function shortDateTime(unixSec: number, lang: Lang): string {
  const date = new Date(unixSec * 1000);
  return dateTimeFormat(lang, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}

/** The date and time, then how long ago ("3m ago") muted, on one line. */
function TimeCell({ entry }: { entry: BackupEntry }): JSX.Element {
  const { lang } = useT("backups");
  return (
    <span className="flex items-baseline gap-2 whitespace-nowrap">
      <time className="tabular-nums" dateTime={isoTime(entry.createdAt)}>
        {shortDateTime(entry.createdAt, lang)}
      </time>
      <span className="text-meta text-muted-foreground">
        <RelativeTime style="narrow" value={entry.createdAt} />
      </span>
    </span>
  );
}

const KIND_ICONS: Record<string, IconSvgElement> = {
  manual: HandIcon,
  scheduled: CalendarClockIcon,
  auto: SaveIcon,
  "pre-restore": HistoryIcon,
  "pre-merge": GitMergeIcon,
};

function KindBadge({ kind, t }: { kind: string; t: TFunction }): JSX.Element {
  const tone = kindTone(kind);
  return (
    <Badge data-tone={tone} icon={KIND_ICONS[kind] ?? ArchiveIcon} iconStyle="line" tone={tone}>
      {kindLabel(kind, t)}
    </Badge>
  );
}

/** A kind's dot and name colours: its badge's disc and label colours. */
const KIND_TONE: Record<ReturnType<typeof kindTone>, { dot: string; text: string }> = {
  primary: { dot: "bg-(--pill-primary)", text: "text-(--pill-primary-fg)" },
  warning: { dot: "bg-(--pill-warning)", text: "text-(--pill-warning-fg)" },
  neutral: { dot: "bg-(--pill-neutral)", text: "text-foreground" },
};

/** The table's kind: a coloured dot and the name in the same colour, one line, no badge. */
function KindLabel({ kind, t }: { kind: string; t: TFunction }): JSX.Element {
  const tone = kindTone(kind);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap font-medium",
        KIND_TONE[tone].text,
      )}
      data-slot="backup-kind"
      data-tone={tone}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", KIND_TONE[tone].dot)}
      />
      {kindLabel(kind, t)}
    </span>
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

/** The note muted on one line, cut with a tooltip when long; a dash when there is none. */
function NoteCell({ entry, t, mask }: { entry: BackupEntry; t: TFunction; mask: Mask }): ReactNode {
  return (
    <TruncatedText className="text-muted-foreground">{noteText(entry, t, mask)}</TruncatedText>
  );
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
            aria-label={label}
            data-row-focus={entry.id}
            loading={busy}
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
  const { t } = useT("backups");
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
        {hint
          ? fillNodes(t("actionHint"), {
              label: <span className="font-medium">{label}</span>,
              hint,
            })
          : label}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Table row actions as three quiet icon buttons, shown while the row is hovered or holds focus (a
 * keyboard user tabbing in reveals them) and while one runs; otherwise a quiet ⋯ stands in. Touch
 * screens, with no hover, always show them.
 */
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
    <div
      className="group/actions relative flex items-center justify-end"
      data-busy={blocked || undefined}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 end-0 flex w-9 items-center justify-center text-muted-foreground transition-opacity duration-150 in-[tr:focus-within]:opacity-0 in-[tr:hover]:opacity-0 group-data-busy/actions:opacity-0 pointer-coarse:hidden"
      >
        <HugeiconsIcon className="size-4" icon={EllipsisVerticalIcon} />
      </span>
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 in-[tr:focus-within]:opacity-100 in-[tr:hover]:opacity-100 group-data-busy/actions:opacity-100 pointer-coarse:opacity-100">
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
    </div>
  );
}

/**
 * A backup as a row of the phone list: time and menu, how long ago and the size, the note, kind
 * and accounts.
 */
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
        // One line: a long count wraps in its own column, so every card's badge sits bottom-left,
        // on the baseline of the count's last line.
        <div className="flex items-baseline-last justify-between gap-3">
          <KindBadge kind={backupKind(entry)} t={t} />
          <span className="min-w-0 text-end text-meta text-muted-foreground">
            {fillNodes(t("common:text.labelValue"), {
              label: t("accountsInBackup"),
              value: <AccountsCell entry={entry} t={t} />,
            })}
          </span>
        </div>
      }
      meta={
        <span className="tabular-nums">
          <RelativeTime value={entry.createdAt} /> · {formatBytes(entry.size, lang)}
        </span>
      }
      title={<time dateTime={isoTime(entry.createdAt)}>{time}</time>}
      variant="row"
    >
      {note === EMPTY ? null : (
        <p className="wrap-break-word text-muted-foreground text-sm">{note}</p>
      )}
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
      {
        id: "kind",
        header: t("kind"),
        cell: (entry) => <KindLabel kind={backupKind(entry)} t={t} />,
      },
      {
        id: "note",
        header: t("note"),
        // One line, taking the width the others leave; a long note is cut with a tooltip.
        className: "w-full max-w-0",
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
      cardLayout="divided"
      // Rows divided inside the card on a phone and a narrow tablet, the table from 48rem: the
      // longer pt-BR and vi headers and the one-line times need that 768 px container for the
      // five columns to fit unscrolled, so the pinned actions never cover the counts.
      cardsBelow="3xl"
      columns={columns}
      data={rows}
      emptyState={emptyState}
      getRowId={(entry) => entry.id}
      inset
      loading={loading}
      pageSize={pageSize}
      renderCard={(entry) => <BackupCard actions={actions} entry={entry} />}
    />
  );
}
