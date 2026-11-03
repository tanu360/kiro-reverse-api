import { type FormEvent, type JSX, useState } from "react";
import { KeyValueGrid } from "@/components/shared/key-value-grid";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Account } from "@/lib/api/types";
import { EMPTY } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { authLabel } from "../account-model";
import { DetailSection, TOUCH_BUTTON, TOUCH_INPUT, useSaveAccountField } from "./detail-section";

export function BasicSection({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const displayEmail = useDisplayEmail();
  const save = useSaveAccountField(account.id);
  const [nickname, setNickname] = useState(account.nickname);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ nickname: nickname.trim() });
  };

  return (
    <DetailSection title={t("detail.basicInfo")}>
      <KeyValueGrid
        items={[
          { label: t("detail.email"), value: displayEmail(account.email, account.id) },
          { label: t("detail.userId"), value: account.userId || EMPTY, mono: true },
          { label: t("detail.authMethod"), value: authLabel(account, t) },
          { label: t("detail.region"), value: account.region || "us-east-1" },
        ]}
      />
      <form className="flex flex-col gap-2" onSubmit={onSubmit}>
        <Field>
          <FieldLabel>{t("detail.nickname")}</FieldLabel>
          <div className="flex w-full gap-2">
            <Input
              className={TOUCH_INPUT}
              maxLength={200}
              onChange={(event) => setNickname(event.target.value)}
              placeholder={t("detail.nicknamePlaceholder")}
              value={nickname}
            />
            <Button
              className={TOUCH_BUTTON}
              loading={save.isPending}
              type="submit"
              variant="outline"
            >
              {t("detail.save")}
            </Button>
          </div>
        </Field>
      </form>
    </DetailSection>
  );
}
