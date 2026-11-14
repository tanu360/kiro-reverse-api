import { DiceFaces05Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { generateMachineId } from "@/lib/api/system";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { hexChars } from "@/lib/input-filters";
import { toast } from "@/lib/toast";
import { isValidMachineId } from "../account-model";
import { EditableFieldRow, useSaveAccountField } from "./detail-section";

/**
 * A UUID or 32 hex characters, or empty. The dice button at the field's end fills a random UUID
 * from the server; a spinner takes the dice's place while the server answers. The edit takes the
 * whole row (`wide`), so a UUID fits on one line in the desktop sheet; a phone's 16 px mono line
 * (no zoom on focus) is still narrower than one, and there the field scrolls rather than wraps.
 */
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
      wide
    >
      <Field invalid={error !== null}>
        <FieldLabel className="sr-only">{t("detail.machineId")}</FieldLabel>
        {/* One line at every width, never wrapped: the row gives the field its whole width. */}
        <InputGroup>
          <InputGroupInput
            maxLength={36}
            autoComplete="off"
            onChange={(event) => onChange(hexChars(event.target.value))}
            placeholder={t("detail.machineIdPlaceholder")}
            spellCheck={false}
            value={value}
            variant="code"
          />
          <InputGroupAddon align="inline-end">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={t("detail.generateRandom")}
                    loading={generate.isPending}
                    onClick={() => generate.mutate()}
                    size="icon-sm"
                    variant="quiet"
                  />
                }
              >
                <HugeiconsIcon icon={DiceFaces05Icon} aria-hidden="true" />
              </TooltipTrigger>
              <TooltipPopup>{t("detail.generateRandom")}</TooltipPopup>
            </Tooltip>
          </InputGroupAddon>
        </InputGroup>
        {error ? <FieldError match>{error}</FieldError> : null}
      </Field>
    </EditableFieldRow>
  );
}
