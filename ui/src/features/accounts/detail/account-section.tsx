import { UserCircleIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { KeyValueGrid, type KeyValueItem } from "@/components/shared/key-value-grid";
import { InlineEditList } from "@/components/shared/property-list";
import { RelativeTime } from "@/components/shared/relative-time";
import { SectionCard } from "@/components/shared/section-card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { upstreamQuery } from "@/lib/api/settings";
import type { Account } from "@/lib/api/types";
import { EMPTY } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { formatCreditAmount, isApiKeyAccount, refreshesThroughOidc } from "../account-model";
import { EditableFieldRow, useSaveAccountField } from "./detail-section";
import { MachineIdRow } from "./machine-id-section";
import { NotesRow, TagsRow } from "./metadata-section";
import { PriorityRow } from "./priority-section";
import { ProxyRow } from "./proxy-section";
import { RegionValue } from "./region-value";
import { WeightRow } from "./weight-section";

/**
 * The account's facts and its own settings in one card. The facts read as a label-over-value
 * grid, two across, so no value sits a card's width away from its label; the email, plan and
 * sign-in method are already the sheet's title and meta line, and the plan credits and reset
 * date its meter. Under them, the editable fields (nickname, notes, tags, machine ID, weight,
 * priority, proxy) are edited in place.
 */
export function AccountSection({ account }: { account: Account }): JSX.Element {
  const { t, lang } = useT("accounts");
  const upstream = useQuery(upstreamQuery()).data;
  // The global overrides beat the account's own region (proxy/kiro_region.go, auth/auth_region.go).
  const regionNote =
    upstream?.apiRegion && isApiKeyAccount(account)
      ? t("detail.regionApiOverride", { region: upstream.apiRegion })
      : upstream?.authRegion && refreshesThroughOidc(account)
        ? t("detail.regionAuthOverride", { region: upstream.authRegion })
        : undefined;
  const facts: KeyValueItem[] = [
    account.userId
      ? { label: t("detail.userId"), value: account.userId, span: 2, mono: true, copy: true }
      : { label: t("detail.userId"), value: EMPTY, span: 2 },
    {
      label: t("detail.region"),
      value: <RegionValue note={regionNote} region={account.region || "us-east-1"} />,
    },
    { label: t("columns.lastUsed"), value: <RelativeTime value={account.lastUsed} /> },
    { label: t("detail.lastRefresh"), value: <RelativeTime value={account.lastRefresh} /> },
  ];
  // A Kiro API key never expires the way an OAuth token does (expiresAt stays 0).
  if (!isApiKeyAccount(account)) {
    facts.splice(3, 0, {
      label: t("detail.tokenExpiry"),
      value: <RelativeTime value={account.expiresAt} />,
    });
  }
  if (account.trialUsageLimit > 0) {
    facts.push(
      {
        label: t("detail.trialCredits"),
        value: `${formatCreditAmount(account.trialUsageCurrent, lang)} / ${formatCreditAmount(account.trialUsageLimit, lang)}`,
      },
      { label: t("detail.trialStatus"), value: account.trialStatus || EMPTY },
      { label: t("detail.trialExpiry"), value: <RelativeTime value={account.trialExpiresAt} /> },
    );
  }
  return (
    <SectionCard icon={UserCircleIcon} slim title={t("detail.account")}>
      <div className="p-4">
        <KeyValueGrid items={facts} />
      </div>
      <InlineEditList>
        <NicknameRow account={account} />
        <NotesRow account={account} />
        <TagsRow account={account} />
        <MachineIdRow account={account} />
        <WeightRow account={account} />
        <PriorityRow account={account} />
        <ProxyRow account={account} />
      </InlineEditList>
    </SectionCard>
  );
}

function NicknameRow({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const save = useSaveAccountField(account.id);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(account.nickname);

  return (
    <EditableFieldRow
      onEdit={() => {
        setDraft(account.nickname);
        setOpen(true);
      }}
      onOpenChange={setOpen}
      onSubmit={() => save.mutate({ nickname: draft.trim() }, { onSuccess: () => setOpen(false) })}
      open={open}
      save={save}
      title={t("detail.nickname")}
      value={account.nickname}
    >
      <Field>
        <FieldLabel className="sr-only">{t("detail.nickname")}</FieldLabel>
        <Input
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t("detail.nicknamePlaceholder")}
          value={draft}
        />
      </Field>
    </EditableFieldRow>
  );
}
