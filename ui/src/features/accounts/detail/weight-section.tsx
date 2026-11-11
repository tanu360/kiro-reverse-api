import { type JSX, useState } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { EditableFieldRow, useSaveAccountField } from "./detail-section";

const MIN_WEIGHT = 0;
const MAX_WEIGHT = 10;

/** 0..10, sent as a JSON number (the server ignores strings). */
export function WeightRow({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const save = useSaveAccountField(account.id);
  const [open, setOpen] = useState(false);
  const [weight, setWeight] = useState<number | null>(account.weight);

  const onSubmit = () => {
    const value = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, Math.trunc(weight ?? 0)));
    setWeight(value);
    save.mutate({ weight: value }, { onSuccess: () => setOpen(false) });
  };

  return (
    <EditableFieldRow
      onEdit={() => {
        setWeight(account.weight);
        setOpen(true);
      }}
      onOpenChange={setOpen}
      onSubmit={onSubmit}
      open={open}
      saving={save.isPending}
      title={t("detail.weight")}
      value={String(account.weight)}
    >
      <Field>
        <FieldLabel className="sr-only">{t("detail.weight")}</FieldLabel>
        <NumberField
          className="w-full sm:w-36"
          max={MAX_WEIGHT}
          min={MIN_WEIGHT}
          onValueChange={(value) => setWeight(value)}
          step={1}
          value={weight}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement />
            <NumberFieldInput aria-label={t("detail.weight")} />
            <NumberFieldIncrement />
          </NumberFieldGroup>
        </NumberField>
        <FieldDescription>{t("detail.weightHint")}</FieldDescription>
      </Field>
    </EditableFieldRow>
  );
}
