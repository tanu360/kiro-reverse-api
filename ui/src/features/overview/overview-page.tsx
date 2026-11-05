import { AlertCircleIcon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { PageHeader, RefreshButton } from "@/components/shared/page-header";
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
  const tone = status === "open" ? "success" : status === "connecting" ? "warning" : "neutral";
  const label =
    status === "open"
      ? t("status.live")
      : status === "connecting"
        ? t("status.reconnecting")
        : t("status.offline");
  // A dot in the disc colour; while live, a ring pings out of it.
  return (
    <Badge aria-live="polite" data-status={status} dot live={status === "open"} tone={tone}>
      {label}
    </Badge>
  );
}

/**
 * One banner with one Retry when /status or /observe/overview fails, instead of an error
 * block in each card group. The cards keep their titles (and last values, if any), and the
 * section cards that failed too show a quiet "Not loaded": this Retry reloads every one of them.
 */
function TotalsErrorBanner(): JSX.Element | null {
  const { t } = useT("overview");
  const { t: tc } = useT();
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  // Same query keys as the cards, so these observers add no requests.
  const status = useQuery(statusQuery());
  const live = useQuery(observeOverviewQuery());
  const first = [status, live].find((query) => query.isError);
  if (!first) return null;
  const retry = async () => {
    setRetrying(true);
    try {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: queryKeys.status }),
        queryClient.refetchQueries({ queryKey: queryKeys.observe.all }),
      ]);
    } finally {
      setRetrying(false);
    }
  };
  return (
    <Alert data-slot="totals-error" variant="error">
      <HugeiconsIcon icon={AlertCircleIcon} aria-hidden="true" />
      <AlertTitle>{t("errors.totals")}</AlertTitle>
      <AlertDescription>{errorMessage(first.error, tc)}</AlertDescription>
      <AlertAction>
        <Button
          loading={retrying || status.isFetching || live.isFetching}
          onClick={() => void retry()}
          size="sm"
          variant="outline"
        >
          <HugeiconsIcon icon={Refresh01Icon} aria-hidden="true" />
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
    // One 16 px rhythm at every width, as the dashboard reference: the strips and cards read as
    // one board rather than separate blocks.
    <div className="@container/main flex flex-col gap-4">
      <PageHeader
        actions={<RefreshButton fetching={refreshing} onRefresh={() => void refresh()} />}
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
