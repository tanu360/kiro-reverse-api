import { WandSparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useMediaQuery } from "@/hooks/use-media-query";
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
  // A phone's 16 px mono line is narrower than a UUID: there the id wraps instead of clipping.
  const phone = useMediaQuery("max-sm");

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

  const onChange = (next: string) => {
    setValue(next);
    if (error) setError(null);
  };

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
        {phone ? (
          <Textarea
            autoComplete="off"
            // One line of text: a pasted line break goes, and Enter saves as in the input.
            onChange={(event) => onChange(event.target.value.replace(/[\r\n]+/g, ""))}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
            placeholder={t("detail.machineIdPlaceholder")}
            rows={1}
            spellCheck={false}
            value={value}
            variant="mono"
          />
        ) : (
          <Input
            autoComplete="off"
            onChange={(event) => onChange(event.target.value)}
            placeholder={t("detail.machineIdPlaceholder")}
            spellCheck={false}
            value={value}
            variant="code"
          />
        )}
        {error ? <FieldError match>{error}</FieldError> : null}
        {/* Under the field, so the field keeps the dialog's full width for a whole UUID. */}
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
