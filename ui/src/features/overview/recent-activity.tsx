import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, CircleCheckIcon, ListIcon } from "lucide-react";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { recentErrorsQuery, recentRequestsPreviewQuery } from "@/lib/api/observe";
import type { ObserveError, RequestRecord } from "@/lib/api/types";
import { EMPTY, formatDateTime, formatDurationMs } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";

const PREVIEW_ROWS = 10;
type ActivityTab = "errors" | "requests";

function TruncatedText({ text }: { text: string }): JSX.Element {
  if (!text) return <span className="text-muted-foreground">{EMPTY}</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="block max-w-80 truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            // Focusable so keyboard users can read the full message in the tooltip.
            // biome-ignore lint/a11y/noNoninteractiveTabindex: tooltip trigger needs focus.
            tabIndex={0}
          />
        }
      >
        {text}
      </TooltipTrigger>
      <TooltipPopup className="max-w-96 break-words">{text}</TooltipPopup>
    </Tooltip>
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
      <ArrowRightIcon aria-hidden="true" />
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
        <span className="text-muted-foreground text-xs tabular-nums">{time}</span>
        {status}
      </div>
      {children}
    </Card>
  );
}

function ErrorStatus({ row }: { row: ObserveError }): JSX.Element {
  if (!row.status) return <span className="text-muted-foreground">{EMPTY}</span>;
  return (
    <Badge className="tabular-nums" variant="error">
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
        cell: (row) => <span className="tabular-nums">{formatDateTime(row.ts, lang)}</span>,
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
        cell: (row) => <span className="font-mono text-xs">{row.model || EMPTY}</span>,
      },
      { id: "status", header: t("activity.status"), cell: (row) => <ErrorStatus row={row} /> },
      {
        id: "message",
        header: t("activity.message"),
        cell: (row) => <TruncatedText text={mask(row.message)} />,
        className: "max-w-80",
      },
    ],
    [t, lang, mask],
  );

  if (!query.data && query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {query.data && query.isError ? (
        <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <DataTable
        caption={t("activity.errors")}
        columns={columns}
        data={rows}
        emptyState={
          <EmptyState
            description={t("activity.noErrorsBody")}
            icon={CircleCheckIcon}
            title={t("activity.noErrors")}
            variant="compact"
          />
        }
        getRowId={(row, index) => `${row.ts}-${row.accountId}-${index}`}
        loading={query.isPending}
        renderMobileCard={(row) => (
          <MobileCard status={<ErrorStatus row={row} />} time={formatDateTime(row.ts, lang)}>
            <DisplayEmail className="block font-medium" email={row.email} id={row.accountId} />
            {row.model ? (
              <span className="truncate font-mono text-muted-foreground text-xs">{row.model}</span>
            ) : null}
            {row.message ? (
              <p className="line-clamp-2 break-words text-muted-foreground text-xs">
                {mask(row.message)}
              </p>
            ) : null}
          </MobileCard>
        )}
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
  if (row.success) return <Badge variant="success">{t("activity.succeeded")}</Badge>;
  return (
    <Badge className="tabular-nums" variant="error">
      {t("activity.failed")}
      {row.status ? ` · ${row.status}` : ""}
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
        cell: (row) => <span className="tabular-nums">{formatDateTime(row.ts, lang)}</span>,
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
        cell: (row) => <span className="font-mono text-xs">{row.model || EMPTY}</span>,
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
        cell: (row) => (
          <span className="tabular-nums">
            {formatDurationMs(row.durationMs, Boolean(row.endpoint))}
          </span>
        ),
      },
    ],
    [t, lang],
  );

  if (!query.data && query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {query.data && query.isError ? (
        <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <DataTable
        caption={t("activity.requests")}
        columns={columns}
        data={rows}
        emptyState={
          <EmptyState
            description={t("activity.noRequestsBody")}
            icon={ListIcon}
            title={t("activity.noRequests")}
            variant="compact"
          />
        }
        getRowId={(row, index) => (row.id === undefined ? `${row.ts}-${index}` : String(row.id))}
        loading={query.isPending}
        renderMobileCard={(row) => (
          <MobileCard status={<RequestStatus row={row} />} time={formatDateTime(row.ts, lang)}>
            <DisplayEmail className="block font-medium" email={row.email} id={row.accountId} />
            <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
              <span className="truncate font-mono">{row.model || EMPTY}</span>
              <span className="shrink-0 tabular-nums">
                {formatDurationMs(row.durationMs, Boolean(row.endpoint))}
              </span>
            </div>
          </MobileCard>
        )}
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
        <TabsPanel className="pt-2" value="errors">
          <ErrorsPanel />
        </TabsPanel>
        <TabsPanel className="pt-2" value="requests">
          <RequestsPanel />
        </TabsPanel>
      </Tabs>
    </SectionCard>
  );
}
