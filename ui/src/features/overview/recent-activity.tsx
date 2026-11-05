import {
  ArrowRight02Icon,
  CircleCheckIcon,
  CircleXIcon,
  ListIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type JSX, type ReactNode, useMemo, useState } from "react";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { DisplayEmail } from "@/components/shared/display-email";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { TokenCell } from "@/components/shared/token-cell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { recentErrorsQuery, recentRequestsPreviewQuery } from "@/lib/api/observe";
import type { ObserveError, RequestRecord } from "@/lib/api/types";
import { EMPTY, formatDateTime, formatDurationMs } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { ResponsiveList } from "./responsive-list";

const PREVIEW_ROWS = 10;
// Below the table width the cards pair up once the card is 36rem wide.
const CARD_GRID = "@xl:grid-cols-2";
// The panel is a tab stop (its first content is not focusable), so it shows where focus is.
const PANEL_CLASS = "mt-2 rounded-lg outline-none focus-outline";
type ActivityTab = "errors" | "requests";

/** Go sends "-" for an unknown model; empty cells show the copy guide's em dash. */
function modelText(model: string | null | undefined): string {
  return !model || model === "-" ? EMPTY : model;
}

/** Model names are set a step smaller; the empty dash stays full size and muted, like the account column's. */
function ModelName({ model, className }: { model?: string; className?: string }): JSX.Element {
  const text = modelText(model);
  if (text === EMPTY) return <span className="text-muted-foreground">{EMPTY}</span>;
  return <span className={cn("text-xs", className)}>{text}</span>;
}

/**
 * The message wraps to two lines. It is plain text, not a focusable tooltip trigger, so each
 * row costs no extra tab stop; the full text is on the Requests page and in the title.
 */
function MessageText({ text }: { text: string }): JSX.Element {
  if (!text) return <span className="text-muted-foreground">{EMPTY}</span>;
  return (
    <span className="line-clamp-2 whitespace-normal break-words" title={text}>
      {text}
    </span>
  );
}

function ViewAllLink({ children, failedOnly }: { children: ReactNode; failedOnly: boolean }) {
  return (
    <Button
      render={<Link search={failedOnly ? { status: "failed" } : {}} to="/requests" />}
      size="sm"
      variant="outline"
    >
      {children}
      <HugeiconsIcon icon={ArrowRight02Icon} aria-hidden="true" />
    </Button>
  );
}

function MobileCard({
  time,
  status,
  children,
}: {
  time: string;
  status: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <Card className="min-w-0 gap-1.5 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">{time}</span>
        {status}
      </div>
      {children}
    </Card>
  );
}

function ErrorStatus({ row }: { row: ObserveError }): JSX.Element {
  if (!row.status) return <span className="text-muted-foreground">{EMPTY}</span>;
  return (
    <Badge icon={CircleXIcon} tone="destructive">
      {row.status}
    </Badge>
  );
}

function ErrorsPanel(): JSX.Element {
  const { t, lang } = useT("overview");
  const mask = useMaskText();
  const query = useQuery(recentErrorsQuery(PREVIEW_ROWS));
  const rows = useMemo(() => (query.data ?? []).slice(0, PREVIEW_ROWS), [query.data]);

  const columns = useMemo<DataTableColumn<ObserveError>[]>(
    () => [
      {
        id: "time",
        header: t("activity.time"),
        cell: (row) => <span>{formatDateTime(row.ts, lang)}</span>,
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
        className: "min-w-56 max-w-80",
      },
    ],
    [t, lang, mask],
  );

  if (!query.data && query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
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
    <div className="flex flex-col gap-3">
      {query.data && query.isError ? (
        <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <ResponsiveList
        at="4xl"
        caption={t("activity.errors")}
        emptyState={empty}
        getRowId={rowId}
        listClassName={CARD_GRID}
        loading={query.isPending}
        renderCard={(row) => (
          <MobileCard status={<ErrorStatus row={row} />} time={formatDateTime(row.ts, lang)}>
            <DisplayEmail className="block font-medium" email={row.email} id={row.accountId} />
            {modelText(row.model) === EMPTY ? null : (
              <span className="truncate text-muted-foreground text-xs">{row.model}</span>
            )}
            {row.message ? (
              <p className="line-clamp-2 break-words text-muted-foreground text-xs">
                {mask(row.message)}
              </p>
            ) : null}
          </MobileCard>
        )}
        rows={rows}
        table={
          <DataTable
            caption={t("activity.errors")}
            columns={columns}
            data={rows}
            emptyState={empty}
            getRowId={rowId}
            loading={query.isPending}
          />
        }
      />
      {rows.length > 0 ? (
        <div className="flex justify-end">
          <ViewAllLink failedOnly>{t("activity.viewAllErrors")}</ViewAllLink>
        </div>
      ) : null}
    </div>
  );
}

function RequestStatus({ row }: { row: RequestRecord }): JSX.Element {
  const { t } = useT("overview");
  if (row.success) {
    return (
      <Badge icon={CircleCheckIcon} tone="success">
        {t("activity.succeeded")}
      </Badge>
    );
  }
  return (
    <Badge icon={CircleXIcon} tone="destructive">
      {t("activity.failed")}
      {row.status ? ` ${row.status}` : ""}
    </Badge>
  );
}

function RequestsPanel(): JSX.Element {
  const { t, lang } = useT("overview");
  const query = useQuery(recentRequestsPreviewQuery(PREVIEW_ROWS));
  const rows = useMemo(() => (query.data?.requests ?? []).slice(0, PREVIEW_ROWS), [query.data]);

  const columns = useMemo<DataTableColumn<RequestRecord>[]>(
    () => [
      {
        id: "time",
        header: t("activity.time"),
        cell: (row) => <span>{formatDateTime(row.ts, lang)}</span>,
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
        cell: (row) => (
          <TokenCell
            cacheReadTokens={row.cacheReadTokens}
            cacheWriteTokens={row.cacheWriteTokens}
            inTokens={row.inTokens}
            outTokens={row.outTokens}
          />
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
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
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
    <div className="flex flex-col gap-3">
      {query.data && query.isError ? (
        <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <ResponsiveList
        at="4xl"
        caption={t("activity.requests")}
        emptyState={empty}
        getRowId={rowId}
        listClassName={CARD_GRID}
        loading={query.isPending}
        renderCard={(row) => (
          <MobileCard status={<RequestStatus row={row} />} time={formatDateTime(row.ts, lang)}>
            <DisplayEmail className="block font-medium" email={row.email} id={row.accountId} />
            <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
              <ModelName className="truncate" model={row.model} />
              <span className="shrink-0">
                {formatDurationMs(row.durationMs, Boolean(row.endpoint))}
              </span>
            </div>
          </MobileCard>
        )}
        rows={rows}
        table={
          <DataTable
            caption={t("activity.requests")}
            columns={columns}
            data={rows}
            emptyState={empty}
            getRowId={rowId}
            loading={query.isPending}
          />
        }
      />
      {rows.length > 0 ? (
        <div className="flex justify-end">
          <ViewAllLink failedOnly={false}>{t("activity.viewAllRequests")}</ViewAllLink>
        </div>
      ) : null}
    </div>
  );
}

/** Port of Studio's subscriber overview: recent errors (default) and recent requests. */
export function RecentActivity(): JSX.Element {
  const { t } = useT("overview");
  const [tab, setTab] = useState<ActivityTab>("errors");

  return (
    <SectionCard
      description={t("activity.description")}
      id="overview-activity"
      title={t("activity.title")}
    >
      <Tabs onValueChange={(value) => setTab(value as ActivityTab)} value={tab}>
        <TabsList aria-label={t("activity.tabs")} className="max-w-full">
          <TabsTab value="errors">{t("activity.errors")}</TabsTab>
          <TabsTab value="requests">{t("activity.requests")}</TabsTab>
        </TabsList>
        {/* Panels mount on demand, so recent requests load only when that tab opens. */}
        <TabsPanel className={PANEL_CLASS} value="errors">
          <ErrorsPanel />
        </TabsPanel>
        <TabsPanel className={PANEL_CLASS} value="requests">
          <RequestsPanel />
        </TabsPanel>
      </Tabs>
    </SectionCard>
  );
}
