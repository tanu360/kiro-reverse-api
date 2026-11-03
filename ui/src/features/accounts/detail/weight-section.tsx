import { type FormEvent, type JSX, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { DetailSection, useSaveAccountField } from "./detail-section";

const MIN_WEIGHT = 0;
const MAX_WEIGHT = 10;

/** 0..10, sent as a JSON number (the server ignores strings). */
export function WeightSection({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const save = useSaveAccountField(account.id);
  const [weight, setWeight] = useState<number | null>(account.weight);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const value = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, Math.trunc(weight ?? 0)));
    setWeight(value);
    save.mutate({ weight: value });
  };

  return (
    <DetailSection title={t("detail.weight")}>
      <form onSubmit={onSubmit}>
        <Field>
          <FieldLabel className="sr-only">{t("detail.weight")}</FieldLabel>
          <div className="flex w-full items-start gap-2">
            <NumberField
              className="w-36"
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
            <Button loading={save.isPending} type="submit" variant="outline">
              {t("detail.save")}
            </Button>
          </div>
          <FieldDescription>{t("detail.weightHint")}</FieldDescription>
        </Field>
      </form>
    </DetailSection>
  );
}
