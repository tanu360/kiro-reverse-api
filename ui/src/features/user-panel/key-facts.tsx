import {
  AiChipIcon,
  Calendar03Icon,
  CircleGaugeIcon,
  HourglassIcon,
  Infinity01Icon,
  Pulse01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { JSX, ReactNode } from "react";
import { MakerLogo, ModelLogo } from "@/components/shared/model-logo";
import type { ModelMaker } from "@/components/shared/model-logos";
import { RelativeTime } from "@/components/shared/relative-time";
import { TruncatedText } from "@/components/shared/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { UserKey } from "@/lib/api/user-panel";
import { EMPTY, formatDuration, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatDay } from "./key-overview";
import { userKeyStatus } from "./key-status";

/** Under this long before its expiry, a key's countdown turns amber. */
const EXPIRY_WARNING_S = 3 * 86_400;

/** The makers whose models a key without a model list may call, as a stack of marks. */
const ALL_MAKERS: readonly ModelMaker[] = ["claude", "deepseek", "qwen", "minimax", "zhipu"];

/** One fact in the strip: icon and label over the value. */
function Fact({
  icon,
  label,
  children,
  className,
}: {
  icon: IconSvgElement;
  label: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 px-4 py-3.5", className)}>
      <dt className="flex items-center gap-1.5 text-meta text-muted-foreground">
        <HugeiconsIcon aria-hidden="true" className="size-4 shrink-0" icon={icon} />
        {label}
      </dt>
      <dd className="min-w-0 font-medium text-sm">{children}</dd>
    </div>
  );
}

/** When the key expires: never, in how long (amber under three days) or how long ago. */
function Expiry({ apiKey }: { apiKey: UserKey }): JSX.Element {
  const { t, lang } = useT("user-panel");
  if (!apiKey.expiresAt) return <>{t("details.never")}</>;
  const now = Date.now() / 1000;
  const left = apiKey.expiresAt - now;
  const expired = userKeyStatus({ ...apiKey, enabled: true }, now) === "expired";
  // A minute at least, so a key on its last seconds never reads "In 0s".
  const span = formatDuration(Math.max(60, Math.abs(left)), lang);
  return (
    <span
      className={cn((expired || left < EXPIRY_WARNING_S) && "text-warning-foreground")}
      data-expiry={expired ? "past" : left < EXPIRY_WARNING_S ? "soon" : "later"}
    >
      {expired ? t("details.expiredAgo", { span }) : t("details.expiresIn", { span })}
      <span className="block font-normal text-meta text-muted-foreground">
        {formatDay(apiKey.expiresAt, lang)}
      </span>
    </span>
  );
}

/** The allowed models as chips with their maker's mark, or "All models" over a stack of marks. */
function ModelChips({ models }: { models: readonly string[] }): JSX.Element {
  const { t } = useT("user-panel");
  if (models.length === 0) {
    return (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="flex -space-x-1">
          {ALL_MAKERS.map((maker) => (
            <span
              className="flex size-6 items-center justify-center rounded-full border border-border-subtle bg-card"
              key={maker}
            >
              <MakerLogo className="size-3.5" maker={maker} />
            </span>
          ))}
        </span>
        {t("details.allModels")}
      </span>
    );
  }
  return (
    <ul aria-label={t("details.models")} className="flex min-w-0 flex-wrap gap-1.5">
      {models.map((model) => (
        <li className="flex min-w-0 max-w-full" key={model}>
          <Badge className="min-w-0 max-w-full font-mono" variant="outline">
            <ModelLogo className="size-3.5" model={model} />
            <TruncatedText>{model}</TruncatedText>
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/**
 * The key's settings in one strip under its usage: the rate limit, its expiry, when it was last
 * used and created, and the models it may call. Two across on a phone (the models on a row of
 * their own), five across from 48rem of card.
 */
export function KeyFacts({ apiKey }: { apiKey: UserKey | undefined }): JSX.Element {
  const { t, lang } = useT("user-panel");
  const bar = <Skeleton className="my-0.5 h-4 w-24" />;
  return (
    <Card className="@container min-w-0" render={<section aria-label={t("details.title")} />}>
      <dl className="grid grid-cols-2 @3xl:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.5fr)] [&>*]:border-border-subtle [&>*:nth-child(even)]:border-s [&>*:nth-child(n+3)]:border-t @3xl:[&>*+*]:border-s @3xl:[&>*]:border-t-0">
        <Fact icon={CircleGaugeIcon} label={t("details.rpm")}>
          {!apiKey ? (
            bar
          ) : apiKey.rpmLimit ? (
            t("details.rpmValue", { n: formatNumber(apiKey.rpmLimit, lang) })
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <HugeiconsIcon
                aria-hidden="true"
                className="size-3.5"
                icon={Infinity01Icon}
                strokeWidth={2}
              />
              {t("details.noRpmLimit")}
            </span>
          )}
        </Fact>
        <Fact icon={HourglassIcon} label={t("details.expires")}>
          {apiKey ? <Expiry apiKey={apiKey} /> : bar}
        </Fact>
        <Fact icon={Pulse01Icon} label={t("details.lastUsed")}>
          {!apiKey ? (
            bar
          ) : apiKey.lastUsedAt ? (
            //! A server clock ahead of this browser's read as "in 2 minutes".
            <RelativeTime value={Math.min(apiKey.lastUsedAt, Math.floor(Date.now() / 1000))} />
          ) : (
            <span className="text-muted-foreground">{t("details.neverUsed")}</span>
          )}
        </Fact>
        <Fact icon={Calendar03Icon} label={t("details.created")}>
          {!apiKey ? (
            bar
          ) : apiKey.createdAt ? (
            formatDay(apiKey.createdAt, lang)
          ) : (
            <span className="text-muted-foreground">{EMPTY}</span>
          )}
        </Fact>
        <Fact className="col-span-2 @3xl:col-span-1" icon={AiChipIcon} label={t("details.models")}>
          {apiKey ? <ModelChips models={apiKey.allowedModels} /> : bar}
        </Fact>
      </dl>
    </Card>
  );
}
