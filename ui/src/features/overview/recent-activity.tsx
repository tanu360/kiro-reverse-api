import {
  Activity01Icon,
  ArrowUpRight01Icon,
  CircleCheckIcon,
  ListIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type JSX, useMemo, useState } from "react";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { DisplayEmail } from "@/components/shared/display-email";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { ListCard } from "@/components/shared/list-card";
import { SectionCard } from "@/components/shared/section-card";
import { TokenCell } from "@/components/shared/token-cell";
import { TruncatedText } from "@/components/shared/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { recentErrorsQuery, recentRequestsPreviewQuery } from "@/lib/api/observe";
import type { ObserveError, RequestRecord } from "@/lib/api/types";
import { EMPTY, formatDateTime, formatDurationMs, formatTime } from "@/lib/format";
import { type Lang, useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { useTotalsFailed } from "./status-cards";

const PREVIEW_ROWS = 10;
type ActivityTab = "errors" | "requests";

/** Go sends "-" for an unknown model; empty cells show the copy guide's em dash. */
function modelText(model: string | null | undefined): string {
  return !model || model === "-" ? EMPTY : model;
}

/** The model in the muted 13 px meta style; a missing one is the muted dash. */
function ModelName({ model }: { model?: string }): JSX.Element {
  return <span className="text-meta text-muted-foreground">{modelText(model)}</span>;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Today's rows show the time alone (tabular), older ones the date and time; the full date and
 * time are in the tooltip either way. Not a tab stop: the tooltip only repeats it in full.
 */
function ActivityTime({ ts, lang }: { ts: number; lang: Lang }): JSX.Element {
  const date = new Date(ts * 1000);
  const full = formatDateTime(ts, lang);
  const text = sameDay(date, new Date()) ? formatTime(ts, lang) : full;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            className="whitespace-nowrap text-meta text-muted-foreground tabular-nums"
            dateTime={date.toISOString()}
          />
        }
      >
        {text}
      </TooltipTrigger>
      <TooltipPopup>{full}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One line, cut at the cell's edge with an ellipsis (the column takes the row's spare width);
 * the full text is a tooltip only when it is cut.
 */
function MessageText({ text }: { text: string }): JSX.Element {
  if (!text) return <span className="text-muted-foreground">{EMPTY}</span>;
  return <TruncatedText>{text}</TruncatedText>;
}

/**
 * An error status: the neutral pill with the red dot (red stays the alert accent). A missing
 * status is the muted dash on a line as tall as the pill, so every row keeps one height.
 */
function ErrorStatus({ row }: { row: ObserveError }): JSX.Element {
  if (!row.status) {
    return <span className="inline-flex h-6 items-center text-muted-foreground">{EMPTY}</span>;
  }
  return (
    <Badge dot tone="destructive" variant="outline">
      {row.status}
    </Badge>
  );
}

function RequestStatus({ row }: { row: RequestRecord }): JSX.Element {
  const { t } = useT("overview");
  if (row.success) {
    return (
      <Badge dot tone="success" variant="outline">
        {t("activity.succeeded")}
      </Badge>
    );
  }
  return (
    <Badge dot tone="destructive" variant="outline">
      {t("activity.failed")}
      {row.status ? ` ${row.status}` : ""}
    </Badge>
  );
}

/** "time · model": the muted meta line of a phone card. */
function CardMeta({
  ts,
  lang,
  model,
  extra,
}: {
  ts: number;
  lang: Lang;
  model?: string;
  extra?: string;
}): JSX.Element {
  const parts = [modelText(model), extra].filter((part) => part && part !== EMPTY);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <ActivityTime lang={lang} ts={ts} />
      {parts.map((part) => (
        <span className="min-w-0 truncate" key={part}>
          {`· ${part}`}
        </span>
      ))}
    </span>
  );
}

function ErrorsPanel(): JSX.Element {
  const { t, lang } = useT("overview");
  const mask = useMaskText();
  const totalsFailed = useTotalsFailed();
  const query = useQuery(recentErrorsQuery(PREVIEW_ROWS));
  const rows = useMemo(() => (query.data ?? []).slice(0, PREVIEW_ROWS), [query.data]);

  const columns = useMemo<DataTableColumn<ObserveError>[]>(
    () => [
      {
        id: "time",
        header: t("activity.time"),
        cell: (row) => <ActivityTime lang={lang} ts={row.ts} />,
      },
      {
        id: "account",
        header: t("activity.account"),
        cell: (row) => (
          <DisplayEmail className="block max-w-56" email={row.email} id={row.accountId} />
        ),
      },
      {
        id: "model",
        header: t("activity.model"),
        cell: (row) => <ModelName model={row.model} />,
      },
      { id: "status", header: t("activity.status"), cell: (row) => <ErrorStatus row={row} /> },
      {
        id: "message",
        header: t("activity.message"),
        cell: (row) => <MessageText text={mask(row.message)} />,
        // The rest of the row, so a message is cut at the cell edge, not at a fixed width.
        className: "w-full max-w-0",
      },
    ],
    [t, lang, mask],
  );

  if (!query.data && query.isError) {
    return totalsFailed ? (
      <ErrorState notLoaded />
    ) : (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  }

  const empty = (
    <EmptyState
      description={t("activity.noErrorsBody")}
      icon={CircleCheckIcon}
      title={t("activity.noErrors")}
      variant="compact"
    />
  );
  const rowId = (row: ObserveError, index: number) => `${row.ts}-${row.accountId}-${index}`;

  return (
    <>
      {query.data && query.isError && !totalsFailed ? (
        <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <DataTable
        caption={t("activity.errors")}
        cardLayout="grid"
        cardsBelow="4xl"
        columns={columns}
        data={rows}
        emptyState={empty}
        getRowId={rowId}
        inset
        loading={query.isPending}
        renderCard={(row) => (
          <ListCard
            badge={row.status ? <ErrorStatus row={row} /> : undefined}
            meta={<CardMeta lang={lang} model={row.model} ts={row.ts} />}
            title={<DisplayEmail email={row.email} id={row.accountId} />}
          >
            {row.message ? (
              // wrap-anywhere: a long token (a JSON blob, a URL) breaks instead of widening the card.
              <p className="line-clamp-2 wrap-anywhere text-meta text-muted-foreground">
                {mask(row.message)}
              </p>
            ) : null}
          </ListCard>
        )}
      />
    </>
  );
}

function RequestsPanel(): JSX.Element {
  const { t, lang } = useT("overview");
  const totalsFailed = useTotalsFailed();
  const query = useQuery(recentRequestsPreviewQuery(PREVIEW_ROWS));
  const rows = useMemo(() => (query.data?.requests ?? []).slice(0, PREVIEW_ROWS), [query.data]);

  const columns = useMemo<DataTableColumn<RequestRecord>[]>(
    () => [
      {
        id: "time",
        header: t("activity.time"),
        cell: (row) => <ActivityTime lang={lang} ts={row.ts} />,
      },
      { id: "status", header: t("activity.status"), cell: (row) => <RequestStatus row={row} /> },
      {
        id: "account",
        header: t("activity.account"),
        cell: (row) => (
          <DisplayEmail className="block max-w-56" email={row.email} id={row.accountId} />
        ),
      },
      {
        id: "model",
        header: t("activity.model"),
        cell: (row) => <ModelName model={row.model} />,
      },
      {
        id: "tokens",
        header: t("activity.tokens"),
        // Two lines tall even without the cache line, so every row is one height.
        cell: (row) => (
          <div className="flex min-h-8 items-center">
            <TokenCell
              cacheReadTokens={row.cacheReadTokens}
              cacheWriteTokens={row.cacheWriteTokens}
              detailClassName="min-w-48"
              inTokens={row.inTokens}
              muteZero={!row.success}
              outTokens={row.outTokens}
            />
          </div>
        ),
      },
      {
        id: "duration",
        header: t("activity.duration"),
        align: "end",
        cell: (row) => <span>{formatDurationMs(row.durationMs, Boolean(row.endpoint))}</span>,
      },
    ],
    [t, lang],
  );

  if (!query.data && query.isError) {
    return totalsFailed ? (
      <ErrorState notLoaded />
    ) : (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  }

  const empty = (
    <EmptyState
      description={t("activity.noRequestsBody")}
      icon={ListIcon}
      title={t("activity.noRequests")}
      variant="compact"
    />
  );
  const rowId = (row: RequestRecord, index: number) =>
    row.id === undefined ? `${row.ts}-${index}` : String(row.id);

  return (
    <>
      {query.data && query.isError && !totalsFailed ? (
        <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <DataTable
        caption={t("activity.requests")}
        cardLayout="grid"
        cardsBelow="4xl"
        columns={columns}
        data={rows}
        // Comfortable rows fit the two-line token cells.
        density="comfortable"
        emptyState={empty}
        getRowId={rowId}
        inset
        loading={query.isPending}
        renderCard={(row) => (
          <ListCard
            badge={<RequestStatus row={row} />}
            meta={
              <CardMeta
                extra={formatDurationMs(row.durationMs, Boolean(row.endpoint))}
                lang={lang}
                model={row.model}
                ts={row.ts}
              />
            }
            title={<DisplayEmail email={row.email} id={row.accountId} />}
          />
        )}
      />
    </>
  );
}

/** The header's "View all ↗": to the failed requests from the errors tab, else to all of them. */
function ViewAllLink({ tab }: { tab: ActivityTab }): JSX.Element {
  const { t } = useT("overview");
  const { t: tc } = useT();
  const errors = tab === "errors";
  return (
    <Button
      aria-label={t(errors ? "activity.viewAllErrors" : "activity.viewAllRequests")}
      render={<Link search={errors ? { status: "failed" } : {}} to="/requests" />}
      size="sm"
      variant="ghost"
    >
      {tc("actions.viewAll")}
      <HugeiconsIcon icon={ArrowUpRight01Icon} aria-hidden="true" />
    </Button>
  );
}

/**
 * Port of Studio's subscriber overview: recent errors (default) and recent requests. The tabs
 * and the "View all" link sit in the header; the table runs edge to edge under it.
 */
export function RecentActivity(): JSX.Element {
  const { t } = useT("overview");
  const [tab, setTab] = useState<ActivityTab>("errors");

  return (
    <Tabs className="min-w-0" onValueChange={(value) => setTab(value as ActivityTab)} value={tab}>
      <SectionCard
        actions={
          <>
            <TabsList aria-label={t("activity.tabs")} size="sm">
              <TabsTab value="errors">{t("activity.errorsTab")}</TabsTab>
              <TabsTab value="requests">{t("activity.requestsTab")}</TabsTab>
            </TabsList>
            <ViewAllLink tab={tab} />
          </>
        }
        description={t("activity.description")}
        descriptionVariant="inline"
        icon={Activity01Icon}
        id="overview-activity"
        slim
        title={t("activity.title")}
      >
        {/* Panels mount on demand, so recent requests load only when that tab opens. */}
        <TabsPanel value="errors">
          <ErrorsPanel />
        </TabsPanel>
        <TabsPanel value="requests">
          <RequestsPanel />
        </TabsPanel>
      </SectionCard>
    </Tabs>
  );
}
