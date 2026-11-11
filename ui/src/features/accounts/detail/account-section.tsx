import { UserCircleIcon } from "@hugeicons/core-free-icons";
import { type JSX, useState } from "react";
import { KeyValueGrid, type KeyValueItem } from "@/components/shared/key-value-grid";
import { InlineEditList } from "@/components/shared/property-list";
import { RelativeTime } from "@/components/shared/relative-time";
import { SectionCard } from "@/components/shared/section-card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Account } from "@/lib/api/types";
import { EMPTY } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { formatCreditAmount } from "../account-model";
import { EditableFieldRow, useSaveAccountField } from "./detail-section";
import { MachineIdRow } from "./machine-id-section";
import { ProxyRow } from "./proxy-section";
import { WeightRow } from "./weight-section";

/**
 * The account's facts and its own settings in one card. The facts read as a label-over-value
 * grid, two across, so no value sits a card's width away from its label; the email, plan and
 * sign-in method are already the sheet's title and meta line, and the plan credits and reset
 * date its meter. Under them, the editable fields (nickname, machine ID, weight, proxy) are
 * edited in place.
 */
export function AccountSection({ account }: { account: Account }): JSX.Element {
  const { t, lang } = useT("accounts");
  const facts: KeyValueItem[] = [
    account.userId
      ? { label: t("detail.userId"), value: account.userId, span: 2, mono: true, copy: true }
      : { label: t("detail.userId"), value: EMPTY, span: 2 },
    { label: t("detail.region"), value: account.region || "us-east-1" },
    { label: t("columns.lastUsed"), value: <RelativeTime value={account.lastUsed} /> },
    { label: t("detail.tokenExpiry"), value: <RelativeTime value={account.expiresAt} /> },
    { label: t("detail.lastRefresh"), value: <RelativeTime value={account.lastRefresh} /> },
  ];
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
      <div className="px-4 py-4 sm:px-6">
        <KeyValueGrid items={facts} />
      </div>
      <InlineEditList>
        <NicknameRow account={account} />
        <MachineIdRow account={account} />
        <WeightRow account={account} />
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
      saving={save.isPending}
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
