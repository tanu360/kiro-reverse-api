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

const MIN_PRIORITY = 0;
const MAX_PRIORITY = 999;

/**
 * 0..999, lower first in the priority routing mode; sent as a JSON number (the server answers
 * 400 priority_range for anything else). Shown in both modes, so the order can be set before
 * switching to priority.
 */
export function PriorityRow({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const save = useSaveAccountField(account.id);
  const [open, setOpen] = useState(false);
  const [priority, setPriority] = useState<number | null>(account.priority);

  const onSubmit = () => {
    const value = Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, Math.trunc(priority ?? 0)));
    setPriority(value);
    save.mutate({ priority: value }, { onSuccess: () => setOpen(false) });
  };

  return (
    <EditableFieldRow
      onEdit={() => {
        setPriority(account.priority);
        setOpen(true);
      }}
      onOpenChange={setOpen}
      onSubmit={onSubmit}
      open={open}
      saving={save.isPending}
      title={t("detail.priority")}
      value={String(account.priority)}
    >
      <Field>
        <FieldLabel className="sr-only">{t("detail.priority")}</FieldLabel>
        <NumberField
          className="w-full sm:w-36"
          max={MAX_PRIORITY}
          min={MIN_PRIORITY}
          onValueChange={(value) => setPriority(value)}
          step={1}
          value={priority}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement />
            <NumberFieldInput aria-label={t("detail.priority")} />
            <NumberFieldIncrement />
          </NumberFieldGroup>
        </NumberField>
        <FieldDescription>{t("detail.priorityHint")}</FieldDescription>
      </Field>
    </EditableFieldRow>
  );
}
