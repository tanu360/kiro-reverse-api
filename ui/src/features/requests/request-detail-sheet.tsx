import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { DisplayEmail } from "@/components/shared/display-email";
import { KeyValueGrid } from "@/components/shared/key-value-grid";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet";
import type { RequestRecord } from "@/lib/api/types";
import { EMPTY, formatCredits, formatDateTime, formatDurationMs, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { ErrorTypeBadge } from "./error-type-badge";
import { ApiKeyCode, endpointLabel, StatusBadge } from "./requests-columns";

function IdValue({ value, copyLabel }: { value?: string; copyLabel: string }): JSX.Element {
  if (!value) return <span className="text-muted-foreground">{EMPTY}</span>;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code className="min-w-0 break-all font-mono text-[0.8125rem]">{value}</code>
      <CopyButton className="shrink-0" label={copyLabel} value={value} />
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{title}</h3>
      {children}
    </section>
  );
}

export interface RequestDetailSheetProps {
  record: RequestRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 1-based position of the record on the current page, or 0 when it left the page. */
  position: number;
  count: number;
  onPrevious?: () => void;
  onNext?: () => void;
}

/** Row detail, adapted from the data-table-filters sheet onto the coss Sheet. */
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

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup className="max-w-lg">
        <SheetHeader>
          <SheetTitle>{t("detail.title")}</SheetTitle>
          <SheetDescription>{record ? formatDateTime(record.ts, lang) : EMPTY}</SheetDescription>
        </SheetHeader>
        {record ? (
          <SheetPanel className="flex flex-col gap-6">
            <KeyValueGrid
              items={[
                { label: t("detail.result"), value: <StatusBadge record={record} /> },
                {
                  label: t("detail.statusCode"),
                  value: record.status ? String(record.status) : EMPTY,
                  mono: true,
                },
                { label: t("endpoint"), value: endpointLabel(record.endpoint, t) },
                { label: t("model"), value: record.model || EMPTY, mono: Boolean(record.model) },
                {
                  label: t("duration"),
                  value: formatDurationMs(record.durationMs, Boolean(record.endpoint)),
                },
                { label: t("credits"), value: formatCredits(record.credits, 4) },
                {
                  label: t("account"),
                  value: <DisplayEmail email={record.email} id={record.accountId} />,
                },
                {
                  label: t("detail.accountId"),
                  value: <IdValue copyLabel={t("detail.copyAccountId")} value={record.accountId} />,
                },
                { label: t("apiKey"), value: <ApiKeyCode value={record.apiKeyMasked} /> },
                {
                  label: t("detail.apiKeyId"),
                  value: <IdValue copyLabel={t("detail.copyApiKeyId")} value={record.apiKeyId} />,
                },
                {
                  label: t("detail.requestId"),
                  value: (
                    <IdValue
                      copyLabel={t("detail.copyRequestId")}
                      value={record.id === undefined ? undefined : String(record.id)}
                    />
                  ),
                },
              ]}
            />

            <Section title={t("tokens")}>
              <KeyValueGrid
                columns={3}
                items={[
                  { label: t("tokens.input"), value: formatNumber(record.inTokens, lang) },
                  { label: t("tokens.output"), value: formatNumber(record.outTokens, lang) },
                  {
                    label: t("tokens.cacheRead"),
                    value: formatNumber(record.cacheReadTokens, lang),
                  },
                  {
                    label: t("tokens.cacheWrite"),
                    value: formatNumber(record.cacheWriteTokens, lang),
                  },
                  {
                    label: t("tokens.total"),
                    value: formatNumber(record.inTokens + record.outTokens, lang),
                  },
                ]}
              />
            </Section>

            {!record.success || record.message ? (
              <Section title={t("error")}>
                <KeyValueGrid
                  columns={1}
                  items={[
                    {
                      label: t("detail.errorType"),
                      value: record.errorType ? <ErrorTypeBadge type={record.errorType} /> : EMPTY,
                    },
                    {
                      label: t("detail.message"),
                      value: (
                        <pre
                          className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 font-mono text-[0.8125rem]"
                          data-testid="request-message"
                        >
                          {maskText(record.message) ||
                            (record.success ? t("detail.noMessage") : t("noErrorMessage"))}
                        </pre>
                      ),
                    },
                  ]}
                />
              </Section>
            ) : null}
          </SheetPanel>
        ) : null}
        <SheetFooter className="flex-row items-center justify-between sm:justify-between">
          <span className="text-muted-foreground text-sm tabular-nums">
            {position > 0 ? t("detail.position", { index: position, count }) : null}
          </span>
          <div className="flex items-center gap-2">
            <Button
              aria-label={t("detail.previous")}
              disabled={!onPrevious}
              className="size-10 md:size-8"
              onClick={onPrevious}
              size="icon"
              variant="outline"
            >
              <ChevronLeftIcon aria-hidden="true" />
            </Button>
            <Button
              aria-label={t("detail.next")}
              disabled={!onNext}
              className="size-10 md:size-8"
              onClick={onNext}
              size="icon"
              variant="outline"
            >
              <ChevronRightIcon aria-hidden="true" />
            </Button>
          </div>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}
