import {
  ArchiveIcon,
  CalendarClockIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  HandIcon,
  HistoryIcon,
  type LucideIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type JSX,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-media-query";
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
  /** Rows with a request in flight; their actions do nothing but stay focusable. */
  busyIds: ReadonlySet<string>;
}

/**
 * The table's minimum width in px (measured: 825 en, 731 zh). Narrower lists render as
 * cards, whatever the viewport, so a tablet or a laptop with the sidebar open never clips the
 * row actions. The actions column is also sticky in case a long note widens a row.
 */
export const TABLE_MIN_WIDTH = 832;

/** Marks each row's first action; it takes focus when the row above it is deleted. */
export const ROW_FOCUS_ATTR = "data-row-focus";

// Busy actions stay in the tab order: a native disabled button would drop focus to <body>.
const BUSY_CLASS = "aria-disabled:pointer-events-none aria-disabled:opacity-64";

// A 44 px hit area around short text triggers on touch screens, without changing the layout.
const TOUCH_HIT_AREA =
  "relative pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:top-1/2 pointer-coarse:after:h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:-translate-y-1/2";

/** Width of the element, or null before it is measured (or when layout gives none, as in jsdom). */
function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const next = element.getBoundingClientRect().width;
      setWidth(next > 0 ? next : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * Text with a hint that opens on hover, focus or tap (a popover, so touch users reach it too).
 * The hint is also part of the accessible name.
 */
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
  const { t } = useT();
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t("a11y.labelWithDetail", { label, detail: hint })}
        className={cn(
          "cursor-default rounded-sm text-left underline decoration-muted-foreground/50 decoration-dotted underline-offset-4 outline-none focus-outline",
          TOUCH_HIT_AREA,
          className,
        )}
        closeDelay={100}
        data-slot="backup-hint-trigger"
        delay={300}
        openOnHover
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup className="max-w-64" initialFocus={false} side="top" tooltipStyle>
        {hint}
      </PopoverPopup>
    </Popover>
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

const KIND_ICONS: Record<string, LucideIcon> = {
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

function AccountsCell({ entry, t }: { entry: BackupEntry; t: TFunction }): JSX.Element {
  const { text, hint } = accountsCell(entry, t);
  if (!hint) return <span className="tabular-nums">{text}</span>;
  return (
    <HintText className="tabular-nums" hint={hint} label={text}>
      {text}
    </HintText>
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
  const busy = actions.busyIds.has(entry.id);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-busy={busy || undefined}
            aria-label={label}
            className="size-10 sm:size-8"
            data-row-focus={entry.id}
            size="icon"
            variant="ghost"
          />
        }
      >
        <EllipsisVerticalIcon aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-44">
        <MenuItem disabled={busy} onClick={() => actions.onDownload(entry)}>
          <DownloadIcon aria-hidden="true" />
          {t("download")}
        </MenuItem>
        <MenuItem disabled={busy} onClick={() => actions.onRestore(entry)}>
          <RotateCcwIcon aria-hidden="true" />
          {t("restore")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={busy} onClick={() => actions.onDelete(entry)} variant="destructive">
          <Trash2Icon aria-hidden="true" />
          {t("delete")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** One quiet icon button with its name in a tooltip. A busy row keeps it focusable. */
function RowIconButton({
  label,
  hint,
  icon: Icon,
  busy,
  destructive = false,
  focusId,
  onClick,
}: {
  label: string;
  hint?: string;
  icon: typeof DownloadIcon;
  busy: boolean;
  destructive?: boolean;
  focusId?: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-busy={busy || undefined}
            aria-disabled={busy || undefined}
            aria-label={label}
            className={cn(
              BUSY_CLASS,
              destructive && "text-destructive-foreground hover:bg-destructive/8",
            )}
            data-row-focus={focusId}
            onClick={() => {
              if (!busy) onClick();
            }}
            size="icon"
            variant="ghost"
          />
        }
      >
        <Icon aria-hidden="true" />
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

/** Table row actions as three ghost icon buttons, quieter than bordered text buttons. */
function RowActions({
  entry,
  actions,
}: {
  entry: BackupEntry;
  actions: BackupRowActions;
}): JSX.Element {
  const { t } = useT("backups");
  const busy = actions.busyIds.has(entry.id);
  return (
    <div className="flex items-center justify-end gap-0.5">
      <RowIconButton
        busy={busy}
        focusId={entry.id}
        hint={t("downloadHint")}
        icon={DownloadIcon}
        label={t("download")}
        onClick={() => actions.onDownload(entry)}
      />
      <RowIconButton
        busy={busy}
        icon={RotateCcwIcon}
        label={t("restore")}
        onClick={() => actions.onRestore(entry)}
      />
      <RowIconButton
        busy={busy}
        destructive
        icon={Trash2Icon}
        label={t("delete")}
        onClick={() => actions.onDelete(entry)}
      />
    </div>
  );
}

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

function BackupCards({
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
  const { t } = useT("backups");
  if (loading && rows.length === 0) {
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        {Array.from({ length: 3 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cards never reorder.
          <Skeleton className="h-20 w-full rounded-xl" key={index} />
        ))}
      </div>
    );
  }
  if (rows.length === 0) return <>{emptyState}</>;
  return (
    <ul aria-label={t("list.caption")} className="flex flex-col gap-2">
      {rows.map((entry) => (
        <li key={entry.id}>
          <BackupCard actions={actions} entry={entry} />
        </li>
      ))}
    </ul>
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(containerRef);
  const isMobile = useIsMobile();
  // The list's own width decides, not the viewport. Before the first measure the viewport does.
  const asCards = width === null ? isMobile : width < TABLE_MIN_WIDTH;

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
        // Pinned to the right edge, so the actions stay in view if the table ever scrolls; opaque
        // in the panel's own fill (the card at 40 % over the page).
        headerClassName:
          "sticky right-0 z-[1] bg-[color-mix(in_srgb,var(--card)_40%,var(--background))]",
        className:
          "sticky right-0 z-[1] bg-[color-mix(in_srgb,var(--card)_40%,var(--background))] py-1",
        cell: (entry) => <RowActions actions={actions} entry={entry} />,
      },
    ],
    [t, lang, mask, actions],
  );

  return (
    <div className="min-w-0" data-layout={asCards ? "cards" : "table"} ref={containerRef}>
      {asCards ? (
        <BackupCards actions={actions} emptyState={emptyState} loading={loading} rows={rows} />
      ) : (
        <DataTable
          bleed
          caption={t("list.caption")}
          columns={columns}
          data={rows}
          emptyState={emptyState}
          getRowId={(entry) => entry.id}
          loading={loading}
        />
      )}
    </div>
  );
}
