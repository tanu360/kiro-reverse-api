import { type FormEvent, type JSX, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { isValidProxyUrl } from "../account-model";
import { DetailSection, useSaveAccountField } from "./detail-section";

export function ProxySection({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const save = useSaveAccountField(account.id);
  const [value, setValue] = useState(account.proxyURL);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const proxyURL = value.trim();
    if (!isValidProxyUrl(proxyURL)) {
      setError(t("detail.proxyFormatError"));
      return;
    }
    setError(null);
    save.mutate({ proxyURL });
  };

  return (
    <DetailSection title={t("detail.proxyURL")}>
      <form noValidate onSubmit={onSubmit}>
        <Field invalid={error !== null}>
          <FieldLabel className="sr-only">{t("detail.proxyURL")}</FieldLabel>
          <div className="flex w-full gap-2">
            <Input
              autoComplete="off"
              className="font-mono"
              onChange={(event) => {
                setValue(event.target.value);
                if (error) setError(null);
              }}
              placeholder={t("detail.proxyURLPlaceholder")}
              spellCheck={false}
              value={value}
            />
            <Button loading={save.isPending} type="submit" variant="outline">
              {t("detail.save")}
            </Button>
          </div>
          {error ? <FieldError match>{error}</FieldError> : null}
          <FieldDescription>{t("detail.proxyHint")}</FieldDescription>
        </Field>
      </form>
    </DetailSection>
  );
}
