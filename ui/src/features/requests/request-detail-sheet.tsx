import {
  AlertCircleIcon,
  ArrowDataTransferHorizontalIcon,
  Coins01Icon,
  FingerPrintIcon,
  Message01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { CreditAmount } from "@/components/shared/credit-amount";
import { PagerChevronButton } from "@/components/shared/data-table-pagination";
import { DisplayEmail } from "@/components/shared/display-email";
import { ModelLogo } from "@/components/shared/model-logo";
import { PropertyList, PropertyRow } from "@/components/shared/property-list";
import {
  ResponsiveSheet,
  ResponsiveSheetDescription,
  ResponsiveSheetFooter,
  ResponsiveSheetHeader,
  ResponsiveSheetPanel,
  ResponsiveSheetTitle,
} from "@/components/shared/responsive-sheet";
import { SectionCard } from "@/components/shared/section-card";
import { StatStrip, type StatStripItem } from "@/components/shared/stat-strip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import type { RequestRecord } from "@/lib/api/types";
import { EMPTY, formatDateTime, formatDurationMs, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { isKnownErrorType, normalizeApiKeyMask, rowKey } from "./request-model";
import { endpointLabel, StatusBadge } from "./requests-columns";

interface RequestDetailSheetProps {
  record: RequestRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 1-based position of the record on the current page, or 0 when it left the page. */
  position: number;
  count: number;
  onPrevious?: () => void;
  onNext?: () => void;
}

/**
 * Row detail on the shared ResponsiveSheet (a right sheet from md up, a bottom sheet on phones),
 * laid out as the account sheet: the model's mark beside the title over the result and the time;
 * then duration, credits and tokens in one strip, and three cards (the request with its account,
 * the tokens, the IDs) with their facts as label and value rows. A failed request leads with its
 * error as a red notice (the sign-in form's soft tag); a message on a succeeded one comes last,
 * neutral.
 */
export function RequestDetailSheet({
  record,
  open,
  onOpenChange,
  position,
  count,
  onPrevious,
  onNext,
}: RequestDetailSheetProps): JSX.Element {
  const { t, lang } = useT("requests");
  const maskText = useMaskText();

  let body: JSX.Element | null = null;
  if (record) {
    const failed = !record.success;
    const apiKey = normalizeApiKeyMask(record.apiKeyMasked);
    const message =
      maskText(record.message) || (failed ? t("noErrorMessage") : t("detail.noMessage"));
    // A failure that used no tokens has nothing to break down: the table shows a dash there too.
    const noUsage =
      failed &&
      record.inTokens + record.outTokens === 0 &&
      !record.cacheReadTokens &&
      !record.cacheWriteTokens;

    const stats: StatStripItem[] = [
      {
        label: t("duration"),
        value: formatDurationMs(record.durationMs, Boolean(record.endpoint), lang),
      },
      {
        label: t("credits"),
        // Nothing was billed for a failure that used no credits: a dash, as in the table.
        value:
          failed && record.credits === 0 ? (
            <span className="font-normal text-muted-foreground">{EMPTY}</span>
          ) : (
            <CreditAmount digits={4} value={record.credits} />
          ),
      },
    ];
    if (!noUsage) {
      stats.push({
        label: t("tokens"),
        value: formatNumber(record.inTokens + record.outTokens, lang),
      });
    }

    // The message as a notice in the sign-in form's soft tag: red with the error's category as
    // its title for a failure, neutral for a message on a request that succeeded.
    const type = record.errorType;
    const notice =
      failed || record.message ? (
        <Alert role="none" variant={failed ? "error" : "default"}>
          <HugeiconsIcon aria-hidden="true" icon={failed ? AlertCircleIcon : Message01Icon} />
          {/* The copy button on the title's line at every width, so a phone keeps it at the top. */}
          <AlertTitle className="flex items-center justify-between gap-2">
            <span className="min-w-0">
              {failed
                ? type
                  ? isKnownErrorType(type)
                    ? t(`errorType.${type}`)
                    : type
                  : t("error")
                : t("detail.message")}
            </span>
            <CopyButton
              className="-my-0.5 -me-1.5 shrink-0"
              label={t("detail.copyMessage")}
              size="icon-xs"
              value={message}
            />
          </AlertTitle>
          <AlertDescription>
            <p className="whitespace-pre-wrap wrap-anywhere" data-testid="request-message">
              {message}
            </p>
          </AlertDescription>
        </Alert>
      ) : null;

    body = (
      // Keyed on the record so Previous and Next open each one scrolled to the top.
      <ResponsiveSheetPanel className="flex flex-col gap-4" key={rowKey(record, position)}>
        {/* A failure leads with its error, above the numbers. */}
        {failed ? notice : null}

        <Card className="@container min-w-0">
          <StatStrip items={stats} />
        </Card>

        <SectionCard icon={ArrowDataTransferHorizontalIcon} slim title={t("detail.request")}>
          <PropertyList>
            <PropertyRow label={t("endpoint")} value={endpointLabel(record.endpoint, t)} />
            <PropertyRow label={t("model")} mono value={record.model} />
            {/* A failure's badge in the header already carries the status code. */}
            {!failed && record.status ? (
              <PropertyRow label={t("detail.statusCode")} value={String(record.status)} />
            ) : null}
            <PropertyRow
              label={t("account")}
              value={<DisplayEmail email={record.email} id={record.accountId} />}
            />
            <PropertyRow label={t("apiKey")} mono value={apiKey} />
          </PropertyList>
        </SectionCard>

        {noUsage ? null : (
          <SectionCard icon={Coins01Icon} slim title={t("tokens")}>
            <PropertyList>
              <PropertyRow label={t("tokens.input")} value={formatNumber(record.inTokens, lang)} />
              <PropertyRow
                label={t("tokens.output")}
                value={formatNumber(record.outTokens, lang)}
              />
              <PropertyRow
                label={t("tokens.cacheRead")}
                value={formatNumber(record.cacheReadTokens, lang)}
              />
              <PropertyRow
                label={t("tokens.cacheWrite")}
                value={formatNumber(record.cacheWriteTokens, lang)}
              />
            </PropertyList>
          </SectionCard>
        )}

        <SectionCard icon={FingerPrintIcon} slim title={t("detail.ids")}>
          <PropertyList>
            <PropertyRow copy label={t("detail.requestId")} mono value={String(record.id ?? "")} />
            <PropertyRow copy label={t("detail.accountId")} mono value={record.accountId} />
            <PropertyRow copy label={t("detail.apiKeyId")} mono value={record.apiKeyId} />
          </PropertyList>
        </SectionCard>

        {failed ? null : notice}
      </ResponsiveSheetPanel>
    );
  }

  return (
    <ResponsiveSheet onOpenChange={onOpenChange} open={open}>
      <ResponsiveSheetHeader className="flex-row items-start gap-3">
        {/* The model maker's mark on the account sheet's avatar tile. Decorative. */}
        <span
          aria-hidden="true"
          className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-surface-2"
        >
          <ModelLogo className="size-5" model={record?.model ?? ""} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <ResponsiveSheetTitle className="truncate">{t("detail.title")}</ResponsiveSheetTitle>
          {/* The result leads the time, as the status pill leads the account sheet's meta line. */}
          <div className="flex min-w-0 items-center gap-2">
            {record ? <StatusBadge record={record} size="sm" /> : null}
            <ResponsiveSheetDescription className="min-w-0 truncate">
              {record ? formatDateTime(record.ts, lang) : EMPTY}
            </ResponsiveSheetDescription>
          </div>
        </div>
      </ResponsiveSheetHeader>
      {body}
      <ResponsiveSheetFooter>
        <span className="text-meta text-muted-foreground tabular-nums">
          {position > 0 ? t("detail.position", { index: position, count }) : null}
        </span>
        <div className="flex items-center gap-2">
          {/* The table pager's chevrons, so both pairs on the page look and dim alike. */}
          <PagerChevronButton
            direction="previous"
            disabled={!onPrevious}
            label={t("detail.previous")}
            onClick={() => onPrevious?.()}
          />
          <PagerChevronButton
            direction="next"
            disabled={!onNext}
            label={t("detail.next")}
            onClick={() => onNext?.()}
          />
        </div>
      </ResponsiveSheetFooter>
    </ResponsiveSheet>
  );
}
