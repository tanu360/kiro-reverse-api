import {
  CircleCheckIcon,
  CircleSlashIcon,
  Clock01Icon,
  KeyRoundIcon,
  TriangleAlertIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";
import { KeyValueGrid, type KeyValueItem } from "@/components/shared/key-value-grid";
import { PageHeader, RefreshButton } from "@/components/shared/page-header";
import { RelativeTime } from "@/components/shared/relative-time";
import { SectionCard } from "@/components/shared/section-card";
import { UnlimitedMark } from "@/components/shared/unlimited-mark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { UserKey } from "@/lib/api/user-panel";
import {
  dateTimeFormat,
  formatDateTime,
  formatItems,
  formatNumber,
  unixToDate,
} from "@/lib/format";
import { type Lang, useT } from "@/lib/i18n";
import { userKeyStatus } from "./key-status";

/** The expiry date alone (no time), short enough for a badge: "Nov 30, 2026". */
function formatDay(unixSec: number, lang: Lang): string {
  return dateTimeFormat(lang, { dateStyle: "medium" }).format(unixToDate(unixSec));
}

/**
 * The key's state in the API keys table's tones: Active (green), Turned off (grey) or Expired
 * (amber); an active key with an expiry also carries "Expires {date}".
 */
export function KeyStatusBadges({ apiKey }: { apiKey: UserKey }): JSX.Element {
  const { t, lang } = useT("user-panel");
  const status = userKeyStatus(apiKey);
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-slot="key-status">
      {status === "off" ? (
        <Badge icon={CircleSlashIcon} tone="neutral">
          {t("status.off")}
        </Badge>
      ) : status === "expired" ? (
        <Badge icon={Clock01Icon} tone="warning">
          {t("status.expired")}
        </Badge>
      ) : (
        <Badge icon={CircleCheckIcon} tone="success">
          {t("status.active")}
        </Badge>
      )}
      {status === "active" && apiKey.expiresAt > 0 ? (
        <Badge icon={Clock01Icon} tone="neutral">
          {t("status.expires", { date: formatDay(apiKey.expiresAt, lang) })}
        </Badge>
      ) : null}
    </span>
  );
}

/**
 * The page heading: the key's name (or "API key"), its masked value and status beside it, the
 * page's one line under it and Refresh at the end. While the key loads the name is a bar.
 */
export function KeyHeading({
  apiKey,
  fetching,
  onRefresh,
}: {
  apiKey: UserKey | undefined;
  fetching: boolean;
  onRefresh: () => void;
}): JSX.Element {
  const { t } = useT("user-panel");
  const refresh = <RefreshButton fetching={fetching} onRefresh={onRefresh} />;
  if (!apiKey) {
    return (
      // PageHeader's frame (a 36 px title row over the description), the name as a bar.
      <div aria-busy="true" className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-48 grow basis-0 flex-col gap-1.5">
          <div className="flex min-h-9 items-center gap-2.5 pointer-coarse:min-h-10">
            <Skeleton className="h-6 w-44" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <p className="text-pretty text-muted-foreground text-sm leading-relaxed">
            {t("description")}
          </p>
        </div>
        {refresh}
      </div>
    );
  }
  return (
    <PageHeader
      actions={refresh}
      description={t("description")}
      meta={
        <>
          <code className="font-mono text-meta text-muted-foreground" data-slot="key-masked">
            {apiKey.keyMasked}
          </code>
          <KeyStatusBadges apiKey={apiKey} />
        </>
      }
      title={apiKey.name || t("title")}
    />
  );
}

/** A key that is off or expired: every request it sends is refused, so the page says why first. */
export function KeyNotice({ apiKey }: { apiKey: UserKey }): JSX.Element | null {
  const { t, lang } = useT("user-panel");
  const status = userKeyStatus(apiKey);
  if (status === "active") return null;
  return (
    <Alert data-status={status} variant="warning">
      <HugeiconsIcon icon={TriangleAlertIcon} aria-hidden="true" />
      <AlertDescription>
        {status === "off"
          ? t("alert.off")
          : t("alert.expired", { date: formatDateTime(apiKey.expiresAt, lang) })}
      </AlertDescription>
    </Alert>
  );
}

/**
 * The key's own settings as the usage sheet lists them: the rate limit, the models it may call,
 * its expiry, and when it was created and last used. Label over value, three across on a wide
 * card.
 */
export function KeyDetailsCard({ apiKey }: { apiKey: UserKey | undefined }): JSX.Element {
  const { t, lang } = useT("user-panel");
  const bar = <Skeleton className="my-0.5 h-4 w-28" />;
  const models = apiKey?.allowedModels ?? [];
  const items: KeyValueItem[] = apiKey
    ? [
        {
          label: t("details.rpm"),
          value: apiKey.rpmLimit ? (
            t("details.rpmValue", { n: formatNumber(apiKey.rpmLimit, lang) })
          ) : (
            <UnlimitedMark />
          ),
        },
        {
          label: t("details.models"),
          value: models.length ? formatItems(models, lang) : t("details.allModels"),
          // A list of models takes two columns; "All models" pairs up.
          span: models.length ? 2 : 1,
        },
        {
          label: t("details.expires"),
          value: apiKey.expiresAt
            ? userKeyStatus(apiKey) === "expired"
              ? t("details.expiredAt", { time: formatDateTime(apiKey.expiresAt, lang) })
              : formatDateTime(apiKey.expiresAt, lang)
            : t("details.never"),
        },
        { label: t("details.created"), value: formatDateTime(apiKey.createdAt, lang) },
        {
          label: t("details.lastUsed"),
          value: apiKey.lastUsedAt ? (
            <RelativeTime value={apiKey.lastUsedAt} />
          ) : (
            t("details.neverUsed")
          ),
        },
      ]
    : [
        { label: t("details.rpm"), value: bar },
        { label: t("details.models"), value: bar },
        { label: t("details.expires"), value: bar },
        { label: t("details.created"), value: bar },
        { label: t("details.lastUsed"), value: bar },
      ];
  return (
    <SectionCard icon={KeyRoundIcon} slim title={t("details.title")}>
      <div className="px-4 py-4 sm:px-6">
        <KeyValueGrid columns={3} items={items} />
      </div>
    </SectionCard>
  );
}
