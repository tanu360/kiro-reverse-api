import { AiBrain01Icon, UsersIcon } from "@hugeicons/core-free-icons";
import { type JSX, useMemo, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import {
  MIX_TABLE_ROWS,
  type MixItem,
  ModelMixPanel,
  ModelMixSkeleton,
} from "@/features/overview/model-mix-card";
import type { ApiKeyUsageBreakdownItem } from "@/lib/api/api-key-usage";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";

type BreakdownKind = "models" | "accounts";
const BREAKDOWN_KINDS: readonly BreakdownKind[] = ["models", "accounts"];

function isBreakdownKind(value: unknown): value is BreakdownKind {
  return value === "models" || value === "accounts";
}

export interface UsageBreakdownCardProps {
  models: ApiKeyUsageBreakdownItem[] | undefined;
  /** Not needed with `showAccounts={false}`. */
  accounts?: ApiKeyUsageBreakdownItem[] | undefined;
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  /**
   * False: the models only, without the Models / Accounts switch (the key holder's page, which
   * never shows accounts).
   */
  showAccounts?: boolean;
  /** The card's title; "Breakdown" by default. */
  title?: string;
}

/**
 * The usage split by model or by account, one at a time behind a switch so the sheet stays short:
 * the Overview's model mix (ModelMixPanel) by requests, a donut of the five busiest and "Other"
 * beside a table of the five, hover linked both ways. Accounts show their email (masked in
 * privacy mode), "Deleted account" for one that no longer exists, and "No account" for requests
 * that reached none.
 */
export function UsageBreakdownCard({
  models,
  accounts,
  loading,
  error,
  onRetry,
  retrying,
  showAccounts = true,
  title: cardTitle,
}: UsageBreakdownCardProps): JSX.Element {
  const { t } = useT("api");
  const displayEmail = useDisplayEmail();
  const [chosen, setKind] = useState<BreakdownKind>("models");
  const kind: BreakdownKind = showAccounts ? chosen : "models";
  const source = kind === "models" ? models : accounts;
  const title = t(`usage.${kind}`);
  const icon = kind === "models" ? AiBrain01Icon : UsersIcon;

  const items = useMemo((): MixItem[] | undefined => {
    if (!source) return undefined;
    const name = (item: ApiKeyUsageBreakdownItem): string => {
      if (kind === "models") return item.id || t("usage.noModel");
      if (!item.id) return t("usage.noAccount");
      return item.label ? displayEmail(item.label, item.id) : t("usage.deletedAccount");
    };
    return source.map((item) => ({
      id: item.id || "-",
      model: name(item),
      reqs: item.requests,
      credits: item.credits,
      // The server counts a key's tokens as one total per model and account.
      tokens: item.tokens,
    }));
  }, [source, kind, t, displayEmail]);
  const total = items?.reduce((sum, item) => sum + item.reqs, 0) ?? 0;
  const rest = Math.max(0, (items?.length ?? 0) - MIX_TABLE_ROWS);

  // As the Overview's model mix: the ring and table run edge to edge (a slim card) only once
  // there is a mix to show; loading, failing and empty sit in the padded panel.
  let body: JSX.Element;
  let slim = false;
  if (!items && error) {
    body = (
      <ErrorState
        error={error}
        onRetry={onRetry}
        retrying={retrying}
        title={t("usage.breakdownFailed")}
      />
    );
  } else if (loading || !items) {
    body = <ModelMixSkeleton besideFrom="xl" />;
  } else if (total === 0) {
    body = <EmptyState icon={icon} title={t("usage.emptyTitle")} variant="compact" />;
  } else {
    slim = true;
    body = (
      <>
        {error ? (
          <ErrorState
            compact
            error={error}
            onRetry={onRetry}
            retrying={retrying}
            title={t("usage.breakdownFailed")}
          />
        ) : null}
        <ModelMixPanel
          // The ring goes beside the table from 36rem, not the Overview's 32rem: the usage
          // sheet's card is only just past 32rem, and there the table had no room for its
          // columns. The sheet stacks them, as the Overview does on a phone.
          besideFrom="xl"
          by="reqs"
          caption={title}
          chartLabel={kind === "models" ? undefined : t("usage.accountsChart")}
          // A new panel per kind, so a hovered row does not carry over to the other list.
          key={kind}
          items={items}
          nameHeader={kind === "models" ? undefined : t("usage.account")}
        />
      </>
    );
  }

  return (
    <SectionCard
      actions={
        showAccounts ? (
          <SegmentedControl
            render={
              <RadioGroupPrimitive
                aria-label={t("usage.breakdown")}
                onValueChange={(next) => {
                  if (isBreakdownKind(next)) setKind(next);
                }}
                value={kind}
              />
            }
            size="sm"
          >
            {BREAKDOWN_KINDS.map((value) => (
              <SegmentedControlItem key={value} render={<RadioPrimitive.Root value={value} />}>
                {t(`usage.${value}`)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        ) : undefined
      }
      description={t("usage.byRequests")}
      descriptionVariant="inline"
      footer={
        rest > 0 ? (
          <p>
            {kind === "models"
              ? t("overview:modelMix.moreModels", { count: rest })
              : t("usage.moreAccounts", { count: rest })}
          </p>
        ) : undefined
      }
      icon={icon}
      slim={slim}
      title={cardTitle ?? t("usage.breakdown")}
    >
      {body}
    </SectionCard>
  );
}
