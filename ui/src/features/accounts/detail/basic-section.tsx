import { UserCircleIcon } from "@hugeicons/core-free-icons";
import { type JSX, useState } from "react";
import { KeyValueGrid } from "@/components/shared/key-value-grid";
import { SectionCard } from "@/components/shared/section-card";
import { CardPanel } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Account } from "@/lib/api/types";
import { EMPTY } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { authLabel } from "../account-model";
import { EditableFieldRow, useSaveAccountField } from "./detail-section";
import { MachineIdRow } from "./machine-id-section";
import { ProxyRow } from "./proxy-section";
import { WeightRow } from "./weight-section";

/**
 * The account's facts (the email is the sheet's title) over its editable fields: nickname,
 * machine ID, weight and proxy, each a row with an Edit dialog.
 */
export function BasicSection({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  return (
    <SectionCard icon={UserCircleIcon} slim title={t("detail.basicInfo")}>
      <CardPanel>
        <KeyValueGrid
          items={[
            account.userId
              ? { label: t("detail.userId"), value: account.userId, mono: true, copy: true }
              : { label: t("detail.userId"), value: EMPTY },
            { label: t("detail.authMethod"), value: authLabel(account, t) },
            { label: t("detail.region"), value: account.region || "us-east-1" },
          ]}
        />
      </CardPanel>
      <NicknameRow account={account} />
      <MachineIdRow account={account} />
      <WeightRow account={account} />
      <ProxyRow account={account} />
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
