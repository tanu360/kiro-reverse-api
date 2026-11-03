import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlertIcon, RotateCwIcon } from "lucide-react";
import { type JSX, useState } from "react";
import { PageHeader } from "@/components/shared/page-header";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { observeOverviewQuery } from "@/lib/api/observe";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/api/server-errors";
import { statusQuery } from "@/lib/api/system";
import { useAdminEventsStatus } from "@/lib/events/admin-events";
import { useT } from "@/lib/i18n";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { LiveTiles } from "./live-tiles";
import { ModelMixCard } from "./model-mix-card";
import { RecentActivity } from "./recent-activity";
import { StatusCards } from "./status-cards";
import { TrafficCard } from "./traffic-card";
import { TrafficHeatmap } from "./traffic-heatmap";

/** Reflects the SSE connection that drives the live refresh. */
function LiveBadge(): JSX.Element {
  const { t } = useT();
  const status = useAdminEventsStatus();
  const variant = status === "open" ? "success" : status === "connecting" ? "warning" : "secondary";
  const label =
    status === "open"
      ? t("status.live")
      : status === "connecting"
        ? t("status.reconnecting")
        : t("status.offline");
  return (
    <Badge aria-live="polite" data-status={status} variant={variant}>
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full bg-current",
          status === "open" && "motion-safe:animate-pulse",
        )}
      />
      {label}
    </Badge>
  );
}

/**
 * One banner with one Retry when /status or /observe/overview fails, instead of an error
 * block in each card group. The cards keep their titles (and last values, if any).
 */
function TotalsErrorBanner(): JSX.Element | null {
  const { t } = useT("overview");
  const { t: tc } = useT();
  // Same query keys as the cards, so these observers add no requests.
  const status = useQuery(statusQuery());
  const live = useQuery(observeOverviewQuery());
  const failed = [status, live].filter((query) => query.isError);
  const first = failed[0];
  if (!first) return null;
  const retrying = failed.some((query) => query.isFetching);
  return (
    <Alert data-slot="totals-error" variant="error">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{t("errors.totals")}</AlertTitle>
      <AlertDescription>{errorMessage(first.error, tc)}</AlertDescription>
      <AlertAction>
        <Button
          disabled={retrying}
          onClick={() => {
            for (const query of failed) void query.refetch();
          }}
          size="sm"
          variant="outline"
        >
          <RotateCwIcon aria-hidden="true" className={cn(retrying && "motion-safe:animate-spin")} />
          {tc("actions.retry")}
        </Button>
      </AlertAction>
    </Alert>
  );
}

export function OverviewPage(): JSX.Element {
  const { t } = useT("overview");
  const { t: tc } = useT();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      // A manual refresh reports its failure; background refetches only update the cards.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.status }, { throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.observe.all }, { throwOnError: true }),
      ]);
    } catch (error) {
      toastError(error, tc);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <PageHeader
        actions={
          <Button disabled={refreshing} onClick={() => void refresh()} size="sm" variant="outline">
            <RotateCwIcon
              aria-hidden="true"
              className={cn(refreshing && "motion-safe:animate-spin")}
            />
            {tc("actions.refresh")}
          </Button>
        }
        description={t("description")}
        meta={<LiveBadge />}
        title={t("title")}
      />
      <TotalsErrorBanner />
      <StatusCards />
      <LiveTiles />
      <TrafficCard />
      {/* Full-width rows: paired, the short heatmap card stretched to the model mix's height
          and left a large blank area. Both time views now sit together under the totals. */}
      <TrafficHeatmap />
      <ModelMixCard />
      <RecentActivity />
    </div>
  );
}
