import { WandSparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { generateMachineId } from "@/lib/api/system";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { isValidMachineId } from "../account-model";
import { EditableFieldRow, useSaveAccountField } from "./detail-section";

/** A UUID or 32 hex characters, or empty; Generate fills a fresh UUID from the server. */
export function MachineIdRow({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const save = useSaveAccountField(account.id);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(account.machineId);
  const [error, setError] = useState<string | null>(null);

  const generate = useMutation({
    mutationFn: generateMachineId,
    onSuccess: (result) => {
      setValue(result.machineId);
      setError(null);
    },
    onError: () => {
      toast.error(t("detail.generateFailed"));
    },
  });

  const onSubmit = () => {
    const machineId = value.trim();
    if (!isValidMachineId(machineId)) {
      setError(t("detail.machineIdError"));
      return;
    }
    setError(null);
    save.mutate({ machineId }, { onSuccess: () => setOpen(false) });
  };

  return (
    <EditableFieldRow
      mono
      onEdit={() => {
        setValue(account.machineId);
        setError(null);
        setOpen(true);
      }}
      onOpenChange={setOpen}
      onSubmit={onSubmit}
      open={open}
      saving={save.isPending}
      title={t("detail.machineId")}
      value={account.machineId}
    >
      <Field invalid={error !== null}>
        <FieldLabel className="sr-only">{t("detail.machineId")}</FieldLabel>
        <Input
          autoComplete="off"
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
          placeholder={t("detail.machineIdPlaceholder")}
          spellCheck={false}
          value={value}
          variant="code"
        />
        {error ? <FieldError match>{error}</FieldError> : null}
        {/* Under the field, so a whole UUID fits in the small dialog's input. */}
        <Button
          loading={generate.isPending}
          onClick={() => generate.mutate()}
          size="sm"
          variant="outline"
        >
          <HugeiconsIcon icon={WandSparklesIcon} aria-hidden="true" />
          {t("detail.generate")}
        </Button>
      </Field>
    </EditableFieldRow>
  );
}
