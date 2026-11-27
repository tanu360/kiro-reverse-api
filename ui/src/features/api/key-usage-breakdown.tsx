import { AiBrain01Icon, ComputerTerminal01Icon, UsersIcon } from "@hugeicons/core-free-icons";
import { type JSX, type ReactNode, useCallback, useMemo, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { SegmentedPicker } from "@/components/shared/segmented-picker";
import { TruncatedText } from "@/components/shared/truncated-text";
import {
  MIX_FOOTER,
  type MixItem,
  ModelMixPanel,
  ModelMixSkeleton,
  mixHiddenCount,
} from "@/features/overview/model-mix-card";
import { CallerLabel, isKnownClient, requestCaller } from "@/features/requests/request-client";
import { isKnownEndpoint } from "@/features/requests/request-model";
import type { ApiKeyUsageBreakdownItem } from "@/lib/api/api-key-usage";
import type { RequestRecord } from "@/lib/api/types";
import { USER_USAGE_OTHER_CLIENT } from "@/lib/api/user-panel";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";

type BreakdownKind = "models" | "accounts" | "clients";
type SwitchOptions = ReadonlyArray<readonly [BreakdownKind, string]>;
/**
 * Each switch's kinds and labels, written out so the locale checks see each key in use: the
 * admin's, and the key holder's, which never shows accounts but who called.
 */
const ADMIN_SWITCH: SwitchOptions = [
  ["models", "usage.models"],
  ["accounts", "usage.accounts"],
];
const HOLDER_SWITCH: SwitchOptions = [
  ["models", "user-panel:clients.byModel"],
  ["clients", "user-panel:clients.byClient"],
];

/**
 * A client row's caller as the Requests table reads it off a request: the id is a coding tool's
 * (REQUEST_CLIENTS) or a client API's (REQUEST_ENDPOINTS); null for "other".
 */
function callerOf(id: string): Pick<RequestRecord, "client" | "endpoint"> | null {
  if (isKnownClient(id)) return { client: id };
  if (isKnownEndpoint(id)) return { endpoint: id };
  return null;
}

interface UsageBreakdownCardProps {
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
  /** The card's title; "Breakdown" by default. With `showClients`, the models view's only. */
  title?: string;
  /**
   * The key holder's page (with `showAccounts={false}`): a By model / By client switch, and the
   * title follows it ("Usage by client"). Each client row is a caller as the Requests table names
   * it, with its mark; "other" for requests from neither a known tool nor a known API.
   */
  showClients?: boolean;
  /** Who called, busiest first (UserUsageBreakdown.clients); only read with `showClients`. */
  clients?: readonly ApiKeyUsageBreakdownItem[] | undefined;
}

/**
 * The usage split by model or by account, one at a time behind a switch so the sheet stays short:
 * the Overview's model mix (ModelMixPanel) by requests, a donut of the five busiest and "Other"
 * beside a table of the five, hover linked both ways. Accounts show their email (masked in
 * privacy mode), "Deleted account" for one that no longer exists, and "No account" for requests
 * that reached none. The key holder's page splits by client instead of by account: the coding
 * tool or API with its mark, as the Requests table shows it, and "Other" for the rest.
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
  showClients = false,
  clients,
}: UsageBreakdownCardProps): JSX.Element {
  const { t } = useT("api");
  const { t: tRequests } = useT("requests");
  const displayEmail = useDisplayEmail();
  const [chosen, setKind] = useState<BreakdownKind>("models");
  const options = showClients ? HOLDER_SWITCH : showAccounts ? ADMIN_SWITCH : null;
  const kind: BreakdownKind = options?.some(([value]) => value === chosen) ? chosen : "models";
  const source = kind === "models" ? models : kind === "accounts" ? accounts : clients;
  const icon =
    kind === "models" ? AiBrain01Icon : kind === "accounts" ? UsersIcon : ComputerTerminal01Icon;
  // The table's caption, the ring's name and the name column's header.
  const view =
    kind === "models"
      ? { caption: t("usage.models"), chart: undefined, header: undefined }
      : kind === "accounts"
        ? {
            caption: t("usage.accounts"),
            chart: t("usage.accountsChart"),
            header: t("usage.account"),
          }
        : {
            caption: t("user-panel:clients.title"),
            chart: t("user-panel:clients.chart"),
            header: t("user-panel:clients.client"),
          };

  // A caller's mark and name, exactly as the Requests table shows it. "Other" has no mark: its
  // name starts where the others' do (past the size-3 mark and its gap-1.5).
  const renderClient = useCallback((item: MixItem): ReactNode => {
    const caller = callerOf(item.id);
    return caller ? (
      <CallerLabel record={caller} />
    ) : (
      <TruncatedText className="ps-4.5">{item.model}</TruncatedText>
    );
  }, []);

  const items = useMemo((): MixItem[] | undefined => {
    if (!source) return undefined;
    const name = (item: ApiKeyUsageBreakdownItem): string => {
      if (kind === "models") return item.id || t("usage.noModel");
      if (kind === "clients") {
        // The Requests table's words for the caller (CallerLabel), for the ring too.
        const caller = requestCaller(callerOf(item.id) ?? {});
        return caller ? tRequests(caller.key) : t("overview:modelMix.other");
      }
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
  }, [source, kind, t, tRequests, displayEmail]);
  const total = items?.reduce((sum, item) => sum + item.reqs, 0) ?? 0;
  const restId = kind === "clients" ? USER_USAGE_OTHER_CLIENT : undefined;
  // What the table leaves out: "Other" gets a row of its own beside five named clients.
  const rest = items ? mixHiddenCount(items, restId) : 0;

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
    body = (
      <EmptyState
        description={t("usage.emptyBody")}
        icon={icon}
        title={t("usage.emptyTitle")}
        variant="compact"
      />
    );
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
          caption={view.caption}
          chartLabel={view.chart}
          // A new panel per kind, so a hovered row does not carry over to the other list.
          key={kind}
          items={items}
          nameHeader={view.header}
          renderName={kind === "clients" ? renderClient : undefined}
          restId={restId}
        />
      </>
    );
  }

  return (
    <SectionCard
      actions={
        options ? (
          <SegmentedPicker
            items={options.map(([value, label]) => ({ value, label: t(label) }))}
            label={t("usage.breakdown")}
            onValueChange={setKind}
            value={kind}
          />
        ) : undefined
      }
      description={t("usage.byRequests")}
      descriptionVariant="inline"
      footer={
        rest > 0 ? (
          <p>
            {kind === "models"
              ? t("overview:modelMix.moreModels", { count: rest })
              : kind === "accounts"
                ? t("usage.moreAccounts", { count: rest })
                : t("user-panel:clients.more", { count: rest })}
          </p>
        ) : undefined
      }
      // 48 / 56 px tall, the count at the end, centred on that height.
      footerClassName={MIX_FOOTER}
      icon={icon}
      slim={slim}
      title={
        kind === "clients" ? t("user-panel:clients.title") : (cardTitle ?? t("usage.breakdown"))
      }
    >
      {body}
    </SectionCard>
  );
}
