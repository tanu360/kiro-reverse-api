import { DiceFaces05Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { generateMachineId } from "@/lib/api/system";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { isValidMachineId } from "../account-model";
import { EditableFieldRow, useSaveAccountField } from "./detail-section";

/**
 * A UUID or 32 hex characters, or empty. The dice button at the field's end fills a random UUID
 * from the server; a spinner takes the dice's place while the server answers.
 */
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
        <InputGroup>
          {phone ? (
            <InputGroupTextarea
              autoComplete="off"
              // The group sizes a textarea for several lines (a taller box, roomier padding); this
              // one keeps the single-line textarea's padding and hugs the id on one or two lines.
              className="*:min-h-0! *:py-1.25! pointer-coarse:*:py-1.75!"
              // One line of text: a pasted line break goes, and Enter saves as in the input.
              onChange={(event) => onChange(event.target.value.replace(/[\r\n]+/g, ""))}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }}
              placeholder={t("detail.machineIdPlaceholder")}
              // The single-line mode: the box hugs the id (one or two lines), no empty third line.
              rows={1}
              spellCheck={false}
              value={value}
              variant="mono"
            />
          ) : (
            <InputGroupInput
              autoComplete="off"
              onChange={(event) => onChange(event.target.value)}
              placeholder={t("detail.machineIdPlaceholder")}
              spellCheck={false}
              value={value}
              variant="code"
            />
          )}
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
