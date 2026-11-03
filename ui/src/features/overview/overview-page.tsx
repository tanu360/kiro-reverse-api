import { useQueryClient } from "@tanstack/react-query";
import { RotateCwIcon } from "lucide-react";
import { type JSX, useState } from "react";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/api/query-keys";
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
      <StatusCards />
      <LiveTiles />
      <TrafficCard />
      <div className="grid grid-cols-1 gap-4 md:gap-6 @4xl/main:grid-cols-2">
        <ModelMixCard />
        <TrafficHeatmap />
      </div>
      <RecentActivity />
    </div>
  );
}
