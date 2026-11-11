import { type JSX, useState } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { isValidProxyUrl } from "../account-model";
import { EditableFieldRow, useSaveAccountField } from "./detail-section";

/** The account's own proxy URL; empty falls back to the global proxy. */
export function ProxyRow({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const save = useSaveAccountField(account.id);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(account.proxyURL);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = () => {
    const proxyURL = value.trim();
    if (!isValidProxyUrl(proxyURL)) {
      setError(t("detail.proxyFormatError"));
      return;
    }
    setError(null);
    save.mutate({ proxyURL }, { onSuccess: () => setOpen(false) });
  };

  return (
    <EditableFieldRow
      mono
      onEdit={() => {
        setValue(account.proxyURL);
        setError(null);
        setOpen(true);
      }}
      onOpenChange={setOpen}
      onSubmit={onSubmit}
      open={open}
      saving={save.isPending}
      title={t("detail.proxyURL")}
      value={account.proxyURL}
    >
      <Field invalid={error !== null}>
        <FieldLabel className="sr-only">{t("detail.proxyURL")}</FieldLabel>
        <Input
          autoComplete="off"
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
          placeholder={t("detail.proxyURLPlaceholder")}
          spellCheck={false}
          value={value}
          variant="code"
        />
        {error ? <FieldError match>{error}</FieldError> : null}
        <FieldDescription>{t("detail.proxyHint")}</FieldDescription>
      </Field>
    </EditableFieldRow>
  );
}
