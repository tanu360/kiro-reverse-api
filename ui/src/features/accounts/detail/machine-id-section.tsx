import { useMutation } from "@tanstack/react-query";
import { WandSparklesIcon } from "lucide-react";
import { type FormEvent, type JSX, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { generateMachineId } from "@/lib/api/system";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { isValidMachineId } from "../account-model";
import { DetailSection, TOUCH_BUTTON, TOUCH_INPUT, useSaveAccountField } from "./detail-section";

export function MachineIdSection({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const save = useSaveAccountField(account.id);
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

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const machineId = value.trim();
    if (!isValidMachineId(machineId)) {
      setError(t("detail.machineIdError"));
      return;
    }
    setError(null);
    save.mutate({ machineId });
  };

  return (
    <DetailSection title={t("detail.machineId")}>
      <form noValidate onSubmit={onSubmit}>
        <Field invalid={error !== null}>
          <FieldLabel className="sr-only">{t("detail.machineId")}</FieldLabel>
          <div className="flex w-full flex-col gap-2 sm:flex-row">
            <Input
              autoComplete="off"
              className={cn("font-mono", TOUCH_INPUT)}
              onChange={(event) => {
                setValue(event.target.value);
                if (error) setError(null);
              }}
              placeholder={t("detail.machineIdPlaceholder")}
              spellCheck={false}
              value={value}
            />
            <div className="flex gap-2">
              <Button
                className={cn("flex-1", TOUCH_BUTTON)}
                loading={generate.isPending}
                onClick={() => generate.mutate()}
                variant="outline"
              >
                <WandSparklesIcon aria-hidden="true" />
                {t("detail.generate")}
              </Button>
              <Button
                className={cn("flex-1", TOUCH_BUTTON)}
                loading={save.isPending}
                type="submit"
                variant="outline"
              >
                {t("detail.save")}
              </Button>
            </div>
          </div>
          {error ? <FieldError match>{error}</FieldError> : null}
        </Field>
      </form>
    </DetailSection>
  );
}
