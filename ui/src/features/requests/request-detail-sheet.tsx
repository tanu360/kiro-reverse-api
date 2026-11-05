import type { JSX, ReactNode } from "react";
import { CodeBlock } from "@/components/shared/code-block";
import { CreditAmount } from "@/components/shared/credit-amount";
import { PagerChevronButton } from "@/components/shared/data-table-pagination";
import { DisplayEmail } from "@/components/shared/display-email";
import { KeyValueGrid, type KeyValueItem } from "@/components/shared/key-value-grid";
import {
  ResponsiveSheet,
  ResponsiveSheetDescription,
  ResponsiveSheetFooter,
  ResponsiveSheetHeader,
  ResponsiveSheetPanel,
  ResponsiveSheetTitle,
} from "@/components/shared/responsive-sheet";
import type { RequestRecord } from "@/lib/api/types";
import { EMPTY, formatDateTime, formatDurationMs, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { ErrorTypeLabel } from "./error-type-badge";
import { normalizeApiKeyMask, rowKey } from "./request-model";
import { endpointLabel, StatusBadge } from "./requests-columns";

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-semibold text-heading leading-6">{title}</h3>
      {children}
    </section>
  );
}

/** An ID on one line in mono with a copy button, or a dash when there is none. */
function idItem(label: string, value: string | number | undefined): KeyValueItem {
  if (value === undefined || value === "") return { label, value: EMPTY, span: 2 };
  return { label, value: String(value), mono: true, copy: true, span: 2 };
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

/**
 * Row detail on the shared ResponsiveSheet (a right sheet from md up, a bottom sheet on phones).
 * A failed request leads with its error; then the request, its tokens, the account and the IDs.
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

  let body: ReactNode = null;
  if (record) {
    const failed = !record.success;
    const apiKey = normalizeApiKeyMask(record.apiKeyMasked);
    const message =
      maskText(record.message) || (failed ? t("noErrorMessage") : t("detail.noMessage"));

    const requestItems: KeyValueItem[] = [
      { label: t("detail.result"), value: <StatusBadge record={record} /> },
    ];
    // A failure's pill already carries the status code.
    if (!failed && record.status) {
      requestItems.push({ label: t("detail.statusCode"), value: String(record.status) });
    }
    requestItems.push(
      { label: t("endpoint"), value: endpointLabel(record.endpoint, t) },
      record.model
        ? { label: t("model"), value: record.model, mono: true }
        : { label: t("model"), value: EMPTY },
      {
        label: t("duration"),
        value: formatDurationMs(record.durationMs, Boolean(record.endpoint), lang),
      },
      {
        label: t("credits"),
        // Nothing was billed for a failure that used no credits: a dash, as in the table.
        value:
          failed && record.credits === 0 ? (
            EMPTY
          ) : (
            <CreditAmount digits={4} value={record.credits} />
          ),
      },
    );

    const errorSection =
      failed || record.message ? (
        <Section key="error" title={t("error")}>
          {record.errorType ? <ErrorTypeLabel className="text-sm" type={record.errorType} /> : null}
          <div className="min-w-0" data-testid="request-message">
            <CodeBlock
              className="[&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere"
              code={message}
              copyLabel={t("detail.copyMessage")}
              title={t("detail.message")}
            />
          </div>
        </Section>
      ) : null;

    // A failure that used no tokens has nothing to break down: the table shows a dash there too.
    const noUsage =
      failed &&
      record.inTokens + record.outTokens === 0 &&
      !record.cacheReadTokens &&
      !record.cacheWriteTokens;

    body = (
      // Keyed on the record so Previous and Next open each one scrolled to the top.
      <ResponsiveSheetPanel className="flex flex-col gap-6" key={rowKey(record, position)}>
        {failed ? errorSection : null}

        <Section title={t("detail.request")}>
          <KeyValueGrid items={requestItems} />
        </Section>

        {noUsage ? null : (
          <Section title={t("tokens")}>
            {/* Pairs that read across: input and output, the two cache counts, then the total. */}
            <KeyValueGrid
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
        )}

        <Section title={t("account")}>
          <KeyValueGrid
            items={[
              {
                label: t("account"),
                value: <DisplayEmail email={record.email} id={record.accountId} />,
              },
              apiKey
                ? { label: t("apiKey"), value: apiKey, mono: true }
                : { label: t("apiKey"), value: EMPTY },
            ]}
          />
        </Section>

        <Section title={t("detail.ids")}>
          <KeyValueGrid
            items={[
              idItem(t("detail.requestId"), record.id),
              idItem(t("detail.accountId"), record.accountId),
              idItem(t("detail.apiKeyId"), record.apiKeyId),
            ]}
          />
        </Section>

        {failed ? null : errorSection}
      </ResponsiveSheetPanel>
    );
  }

  return (
    <ResponsiveSheet onOpenChange={onOpenChange} open={open}>
      <ResponsiveSheetHeader>
        <ResponsiveSheetTitle>{t("detail.title")}</ResponsiveSheetTitle>
        <ResponsiveSheetDescription>
          {record ? formatDateTime(record.ts, lang) : EMPTY}
        </ResponsiveSheetDescription>
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
