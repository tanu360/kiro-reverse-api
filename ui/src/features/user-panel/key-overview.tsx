import {
  AlertCircleIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  Clock01Icon,
  InformationCircleIcon,
  TriangleAlertIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";
import { PageHeader, PageHeaderLayout, RefreshButton } from "@/components/shared/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { UserKey } from "@/lib/api/user-panel";
import { dateTimeFormat, formatDateTime, unixToDate } from "@/lib/format";
import { type Lang, useT } from "@/lib/i18n";
import { type UserKeyStatus, userKeyStatus } from "./key-status";

/** A date alone (no time), short enough for a badge: "Nov 30, 2026". */
export function formatDay(unixSec: number, lang: Lang): string {
  return dateTimeFormat(lang, { dateStyle: "medium" }).format(unixToDate(unixSec));
}

/**
 * The key's state in the API keys table's tones: Active (green), Turned off (grey), Expired
 * (amber) or Limit reached (amber) for a token, credit or call limit; an active key with an
 * expiry also carries "Expires {date}".
 */
function KeyStatusBadges({ apiKey }: { apiKey: UserKey }): JSX.Element {
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
      ) : status !== "active" ? (
        <Badge icon={AlertCircleIcon} tone="destructive">
          {t("status.limitReached")}
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
 * page's one line under it and Refresh at the end. While the key loads the name is a bar; when
 * it failed to load (the card below says why) the heading is the plain "API key".
 */
export function KeyHeading({
  apiKey,
  failed = false,
  fetching,
  onRefresh,
}: {
  apiKey: UserKey | undefined;
  failed?: boolean;
  fetching: boolean;
  onRefresh: () => void;
}): JSX.Element {
  const { t } = useT("user-panel");
  const refresh = <RefreshButton fetching={fetching} onRefresh={onRefresh} />;
  if (!apiKey && failed) {
    return <PageHeader actions={refresh} description={t("description")} title={t("title")} />;
  }
  if (!apiKey) {
    return (
      // PageHeader's frame (a 36 px title row over the description), with bars for the name,
      // the masked key and the status that wrap as they do: the status takes a second line on
      // a phone, so the cards below stay put when the key arrives.
      <PageHeaderLayout
        actions={refresh}
        busy
        description={t("description")}
        heading={
          <>
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-6 w-18 rounded-full" />
          </>
        }
      />
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

/** Why the proxy refuses the key's requests, and what the admin must do about it. */
const REFUSED_ALERT = {
  off: "alert.off",
  tokenLimit: "alert.tokenLimit",
  creditLimit: "alert.creditLimit",
  callLimit: "alert.callLimit",
} as const satisfies Record<Exclude<UserKeyStatus, "active" | "expired">, string>;

/**
 * What the page says first: a key that is off, expired or at a limit has every request refused;
 * a server that does not require API keys counts calls to its own address for no key, so they
 * are missing here.
 */
export function KeyNotice({ apiKey }: { apiKey: UserKey }): JSX.Element | null {
  const { t, lang } = useT("user-panel");
  const status = userKeyStatus(apiKey);
  if (status === "active" && apiKey.keysRequired) return null;
  return (
    <>
      {status === "active" ? null : (
        <Alert data-status={status} variant="warning">
          <HugeiconsIcon icon={TriangleAlertIcon} aria-hidden="true" />
          <AlertDescription>
            {status === "expired"
              ? t("alert.expired", { date: formatDateTime(apiKey.expiresAt, lang) })
              : t(REFUSED_ALERT[status])}
          </AlertDescription>
        </Alert>
      )}
      {apiKey.keysRequired ? null : (
        <Alert data-status="not-required" role="note" variant="info">
          <HugeiconsIcon icon={InformationCircleIcon} aria-hidden="true" />
          <AlertDescription>{t("alert.notRequired")}</AlertDescription>
        </Alert>
      )}
    </>
  );
}
