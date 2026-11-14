import { ChartColumnIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type JSX, type ReactNode, useMemo, useState } from "react";
import {
  DataTable,
  type DataTableColumn,
  type DataTableSort,
} from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { ListCard } from "@/components/shared/list-card";
import { RelativeTime } from "@/components/shared/relative-time";
import { SectionCard } from "@/components/shared/section-card";
import { Badge } from "@/components/ui/badge";
import { CardPanel } from "@/components/ui/card";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import {
  API_KEY_USAGE_RANGES,
  type ApiKeyUsageRange,
  type ApiKeyUsageTotals,
  apiKeyUsageQuery,
} from "@/lib/api/api-key-usage";
import { apiKeysQuery } from "@/lib/api/api-keys";
import { settingsQuery } from "@/lib/api/settings";
import type { ApiKey } from "@/lib/api/types";
import {
  formatCompact,
  formatCredits,
  formatFraction,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { useT } from "@/lib/i18n";
import { type UsageIdentity, useUsageLabel } from "./key-usage-label";
import { entryRef } from "./key-usage-model";
import { ApiKeyUsageSheet } from "./key-usage-sheet";

/** A failure rate from this share up reads as a problem: the badge turns red. */
const HIGH_FAILURE_RATE = 0.05;
/** A limit used past this share turns its meter amber; a spent one turns it red. */
const LIMIT_WARNING = 0.75;

type SortColumn = "requests" | "failed" | "credits" | "tokens" | "lastUsed";
const SORT_COLUMNS: readonly SortColumn[] = ["requests", "failed", "credits", "tokens", "lastUsed"];
const DEFAULT_SORT: DataTableSort = { id: "requests", desc: true };
/** Rows per page, as the API keys table. */
const PAGE_SIZE = 10;

function isRange(value: unknown): value is ApiKeyUsageRange {
  return typeof value === "string" && (API_KEY_USAGE_RANGES as readonly string[]).includes(value);
}

function isSortColumn(value: string): value is SortColumn {
  return (SORT_COLUMNS as readonly string[]).includes(value);
}

function failureRate(totals: ApiKeyUsageTotals): number {
  return totals.requests > 0 ? totals.failed / totals.requests : 0;
}

interface Row {
  key: string;
  icon: ReactNode;
  label: ReactNode;
  /** The opener's accessible name. */
  openLabel?: string;
  /** What the sheet shows while it loads. */
  identity?: UsageIdentity;
  totals: ApiKeyUsageTotals;
  /** The configured key behind a "key" entry: its last use and limits. */
  apiKey?: ApiKey;
}

interface SheetState {
  ref: string;
  identity: UsageIdentity;
  range: ApiKeyUsageRange;
  open: boolean;
  /** Bumped on every opening, so the sheet remounts with the card's range. */
  session: number;
}

/** A sort value; rows without one (no last use) sort after every row that has it. */
function sortValue(row: Row, column: SortColumn): number {
  switch (column) {
    case "failed":
      return failureRate(row.totals);
    case "credits":
      return row.totals.credits;
    case "tokens":
      return row.totals.tokens;
    case "lastUsed":
      return row.apiKey?.lastUsedAt ?? -1;
    default:
      return row.totals.requests;
  }
}

/** The key's first limit that is set, in the order the key form lists them: credits, tokens, calls. */
function firstLimit(
  apiKey: ApiKey,
): { kind: "credits" | "tokens" | "calls"; used: number; limit: number } | null {
  if (apiKey.creditLimit)
    return { kind: "credits", used: apiKey.creditsUsed, limit: apiKey.creditLimit };
  if (apiKey.tokenLimit)
    return { kind: "tokens", used: apiKey.tokensUsed, limit: apiKey.tokenLimit };
  if (apiKey.callLimit) {
    return { kind: "calls", used: apiKey.successfulCalls ?? 0, limit: apiKey.callLimit };
  }
  return null;
}

/**
 * Usage by key over 24 hours, 7 or 30 days or the lifetime, from the request log (Lifetime adds
 * the totals log retention kept of pruned rows), as a table sorted by any number: requests,
 * failure rate, credits, tokens or last use, with how much of its limit each key has used, laid
 * out as the API keys table: flush in the card, ten rows a page, cards below a 56rem card. No API
 * key, invalid keys and deleted keys are rows of their own. A row opens that key's usage sheet.
 */
export function KeyUsageCard(): JSX.Element {
  const { t, lang } = useT("api");
  const label = useUsageLabel();
  const [range, setRange] = useState<ApiKeyUsageRange>("24h");
  const [sort, setSort] = useState<DataTableSort>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const query = useQuery(apiKeyUsageQuery(range));
  const keys = useQuery(apiKeysQuery());
  const settings = useQuery(settingsQuery());
  const data = query.data;

  const allRows = useMemo((): Row[] => {
    if (!data) return [];
    const byId = new Map((keys.data ?? []).map((apiKey) => [apiKey.id, apiKey]));
    return data.keys.map((entry) => {
      const shown = label(entry);
      let text: ReactNode;
      if (shown.group) {
        text = (
          <>
            <span className="min-w-0 truncate text-muted-foreground">{shown.title}</span>
            {/* The masked key tells two deleted keys apart, so the group name gives way first. */}
            {shown.keyMasked ? (
              <span className="shrink-0 font-mono text-meta text-muted-foreground">
                {shown.keyMasked}
              </span>
            ) : null}
          </>
        );
      } else if (!shown.named && shown.keyMasked) {
        // An unnamed key goes by its masked value: "Unnamed key" twice would tell them apart.
        text = <span className="min-w-0 truncate font-mono text-meta">{shown.keyMasked}</span>;
      } else {
        // Medium weight, as the API keys table's names.
        text = <span className="min-w-0 truncate font-medium">{shown.title}</span>;
      }
      return {
        key: entryRef(entry),
        icon: (
          <HugeiconsIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
            icon={shown.icon}
          />
        ),
        label: text,
        openLabel: t("usage.open", {
          name: shown.named || !shown.keyMasked ? shown.title : shown.keyMasked,
        }),
        identity: { kind: entry.kind, name: entry.name, keyMasked: entry.keyMasked },
        totals: entry.totals,
        apiKey: entry.kind === "key" ? byId.get(entry.id) : undefined,
      };
    });
  }, [data, keys.data, label, t]);

  const rows = useMemo((): Row[] => {
    const column: SortColumn = isSortColumn(sort.id) ? sort.id : "requests";
    const sign = sort.desc ? -1 : 1;
    // Ties fall back to requests, then to the handle, so rows never reorder on a refetch.
    const sorted = [...allRows].sort(
      (a, b) =>
        sign * (sortValue(a, column) - sortValue(b, column)) ||
        b.totals.requests - a.totals.requests ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    return sorted;
  }, [allRows, sort]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const onlyKeyless =
    data !== undefined && data.keys.length > 0 && data.keys.every((entry) => entry.kind === "none");
  // Keyless traffic means the requirement is off, or, with it on, clients that send no key and
  // get a 401. No hint until the setting has loaded.
  const requireApiKey = settings.data?.requireApiKey;

  const openSheet = (row: Row) => {
    if (!row.identity) return;
    const identity = row.identity;
    setSheet((current) => ({
      ref: row.key,
      identity,
      range,
      open: true,
      session: (current?.session ?? 0) + 1,
    }));
  };

  const failedCell = (row: Row): ReactNode => {
    if (row.totals.requests === 0) return <span className="text-muted-foreground">—</span>;
    const rate = failureRate(row.totals);
    return (
      <>
        <span className="sr-only">
          {t("usage.failedCount", {
            count: row.totals.failed,
            n: formatNumber(row.totals.failed, lang),
          })}
        </span>
        <Badge
          aria-hidden="true"
          className="tabular-nums"
          size="sm"
          tone={rate >= HIGH_FAILURE_RATE ? "destructive" : "neutral"}
        >
          {/* One decimal keeps the column narrow; no failures read 0%, not 0.0%. */}
          {row.totals.failed > 0
            ? formatFraction(rate, 1, lang)
            : formatPercent(0, row.totals.requests, lang)}
        </Badge>
      </>
    );
  };

  // A table cell keeps the meter 8rem wide; a card gives it the card's width.
  const limitCell = (row: Row, fill = false): ReactNode => {
    if (!row.apiKey) return <span className="text-muted-foreground">—</span>;
    const limit = firstLimit(row.apiKey);
    if (!limit)
      return <span className="text-muted-foreground text-xs">{t("common:unlimited")}</span>;
    const share = limit.limit > 0 ? limit.used / limit.limit : 0;
    // The exact amounts for a screen reader; the cell shows 95.1M / 100M so the column stays narrow.
    const exact = (value: number) =>
      limit.kind === "credits" ? formatCredits(value, 2, lang) : formatNumber(value, lang);
    const format = (value: number) =>
      limit.kind === "credits" && value < 1000
        ? formatCredits(value, 2, lang)
        : formatCompact(value, lang);
    return (
      <Meter
        aria-label={t(`keys.${limit.kind}Usage`, {
          used: exact(limit.used),
          limit: exact(limit.limit),
        })}
        className={fill ? "w-full gap-1" : "w-32 gap-1"}
        max={limit.limit}
        value={Math.min(limit.used, limit.limit)}
      >
        <span className="flex justify-between gap-2 text-meta">
          <span className="text-muted-foreground">{t(`keys.${limit.kind}`)}</span>
          <span className="tabular-nums">
            {t("usage.limitValue", { used: format(limit.used), limit: format(limit.limit) })}
          </span>
        </span>
        <MeterTrack>
          <MeterIndicator
            tone={share >= 1 ? "destructive" : share >= LIMIT_WARNING ? "warning" : "default"}
          />
        </MeterTrack>
      </Meter>
    );
  };

  const lastUsedCell = (row: Row): ReactNode =>
    row.apiKey?.lastUsedAt ? (
      <RelativeTime value={row.apiKey.lastUsedAt} />
    ) : (
      <span className="text-muted-foreground">—</span>
    );

  const nameCell = (row: Row): ReactNode => (
    <span className="flex min-w-0 items-center gap-2.5">
      {row.icon}
      <span className="flex min-w-0 items-baseline gap-2">{row.label}</span>
    </span>
  );

  const columns: DataTableColumn<Row>[] = [
    {
      id: "key",
      header: t("usage.col.key"),
      // Takes the width the numbers leave and cuts a long name.
      className: "w-full max-w-0",
      cell: nameCell,
    },
    {
      id: "requests",
      header: t("usage.metric.requests"),
      sortable: true,
      align: "end",
      cell: (row) => <span className="font-medium">{formatNumber(row.totals.requests, lang)}</span>,
    },
    { id: "failed", header: t("usage.failed"), sortable: true, align: "end", cell: failedCell },
    {
      id: "credits",
      header: t("usage.metric.credits"),
      sortable: true,
      align: "end",
      cell: (row) => formatCredits(row.totals.credits, 2, lang),
    },
    {
      id: "tokens",
      header: t("usage.metric.tokens"),
      sortable: true,
      align: "end",
      cell: (row) => formatCompact(row.totals.tokens, lang),
    },
    { id: "lastUsed", header: t("keys.lastUsed"), sortable: true, cell: lastUsedCell },
    { id: "limit", header: t("usage.col.limit"), cell: (row) => limitCell(row) },
  ];

  // Below a 56rem card, a card per key in a grid, as the API keys table does.
  const renderCard = (row: Row): ReactNode => (
    <ListCard
      badge={failedCell(row)}
      meta={
        <span className="flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
          <span>
            {t("usage.requestsCount", {
              count: row.totals.requests,
              n: formatNumber(row.totals.requests, lang),
            })}
          </span>
          <span>{t("usage.creditsTotal", { n: formatCredits(row.totals.credits, 2, lang) })}</span>
          {row.apiKey?.lastUsedAt ? <RelativeTime value={row.apiKey.lastUsedAt} /> : null}
        </span>
      }
      title={nameCell(row)}
    >
      {row.apiKey && firstLimit(row.apiKey) ? limitCell(row, true) : null}
    </ListCard>
  );

  const emptyState = (
    <EmptyState
      description={t("usage.emptyBody")}
      icon={ChartColumnIcon}
      inCard
      title={t("usage.emptyTitle")}
    />
  );
  const meta = data
    ? t("usage.meta", {
        count: allRows.length,
        n: formatNumber(allRows.length, lang),
        requests: formatNumber(data.totals.requests, lang),
      })
    : undefined;

  return (
    <SectionCard
      actions={
        // A radio group: one tab stop, the arrow keys move the range.
        <SegmentedControl
          render={
            <RadioGroupPrimitive
              aria-label={t("usage.range")}
              onValueChange={(next) => {
                if (isRange(next)) {
                  setRange(next);
                  setPage(1);
                }
              }}
              value={range}
            />
          }
          size="sm"
        >
          {API_KEY_USAGE_RANGES.map((value) => (
            <SegmentedControlItem key={value} render={<RadioPrimitive.Root value={value} />}>
              {t(`usage.range.${value}`)}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      }
      // Clips the last row's hover tint to the card's rounded corners.
      className="overflow-hidden"
      description={t(`usage.description.${range}`)}
      descriptionVariant="inline"
      footer={
        rows.length > PAGE_SIZE ? (
          <DataTablePagination
            onPageChange={setPage}
            page={currentPage}
            pageSize={PAGE_SIZE}
            total={rows.length}
          />
        ) : undefined
      }
      icon={ChartColumnIcon}
      id="api-key-usage"
      meta={meta}
      slim
      title={t("usage.title")}
    >
      {query.isError ? (
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
          title={t("usage.loadFailed")}
        />
      ) : null}
      {!data && query.isError ? null : (
        <div className="min-w-0">
          <DataTable
            caption={t("usage.list")}
            cardLayout="grid"
            cardsBelow="4xl"
            // Rows as tall as the other tables' (Requests 55 px, API keys 57 px), whether or not
            // a row carries a limit meter.
            className="[&_tbody_tr]:h-14"
            columns={columns}
            data={pageRows}
            density="comfortable"
            defaultSortDesc={() => true}
            emptyState={emptyState}
            getRowId={(row) => row.key}
            inset
            loading={!data}
            onRowClick={openSheet}
            onSortChange={(next) => {
              if (isSortColumn(next.id)) {
                setSort(next);
                setPage(1);
              }
            }}
            renderCard={renderCard}
            rowLabel={(row) => row.openLabel ?? ""}
            sort={sort}
          />
        </div>
      )}
      {onlyKeyless && requireApiKey !== undefined ? (
        <CardPanel>
          <p className="text-muted-foreground text-sm">
            {t(requireApiKey ? "usage.keylessRejected" : "usage.notTracked")}
          </p>
        </CardPanel>
      ) : null}
      {sheet ? (
        <ApiKeyUsageSheet
          entryRef={sheet.ref}
          identity={sheet.identity}
          initialRange={sheet.range}
          key={sheet.session}
          onOpenChange={(open) => setSheet((current) => (current ? { ...current, open } : null))}
          open={sheet.open}
        />
      ) : null}
    </SectionCard>
  );
}
