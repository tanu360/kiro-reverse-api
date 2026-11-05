import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type JSX, useId, useRef, useState } from "react";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import { createApiKey, updateApiKey } from "@/lib/api/api-keys";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/api/server-errors";
import type { ApiKey } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import {
  type ApiKeyFormData,
  type ApiKeyFormValues,
  buildCreateRequest,
  buildUpdateRequest,
  EMPTY_API_KEY_FORM,
  formValuesFromKey,
  parseApiKeyForm,
} from "./api-key-form";

export type ApiKeyDialogTarget = { mode: "create" } | { mode: "edit"; apiKey: ApiKey };

/**
 * Create and edit form in one dialog. The parent remounts it for every opening, so each one
 * starts from fresh values. Server errors (duplicate key, collision, limits) show inside it.
 */
export function ApiKeyFormDialog({
  open,
  target,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  target: ApiKeyDialogTarget;
  onOpenChange: (open: boolean) => void;
  /** The full secret from the create response, for the created-key panel. */
  onCreated: (key: string) => void;
}): JSX.Element {
  const { t } = useT("api");
  const queryClient = useQueryClient();
  const editing = target.mode === "edit";
  const [values, setValues] = useState<ApiKeyFormValues>(() =>
    target.mode === "edit" ? formValuesFromKey(target.apiKey) : EMPTY_API_KEY_FORM,
  );
  const [limitsError, setLimitsError] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const limitsErrorId = useId();

  const mutation = useMutation({
    mutationFn: async (data: ApiKeyFormData): Promise<string | null> => {
      if (target.mode === "edit") {
        await updateApiKey(target.apiKey.id, buildUpdateRequest(data));
        return null;
      }
      const created = await createApiKey(buildCreateRequest(data));
      return created.key;
    },
    onSuccess: (createdKey) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
      toast.success(editing ? t("form.updated") : t("form.created"));
      if (createdKey) onCreated(createdKey);
      onOpenChange(false);
    },
  });

  const set = <K extends keyof ApiKeyFormValues>(field: K, value: ApiKeyFormValues[K]) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    if (field === "tokenLimit" || field === "creditLimit") setLimitsError(false);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.isPending) return;
    const parsed = parseApiKeyForm(values);
    if (!parsed.ok) {
      setLimitsError(true);
      return;
    }
    mutation.mutate(parsed.value);
  };

  const limitsDescribedBy = limitsError ? limitsErrorId : undefined;
  const submitLabel = editing ? t("common:actions.save") : t("form.submitCreate");
  const pendingLabel = editing ? t("common:actions.saving") : t("form.submitCreating");

  return (
    <ResponsiveDialog
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            {t("common:actions.cancel")}
          </Button>
          <Button
            form={formId}
            loading={mutation.isPending}
            loadingText={pendingLabel}
            type="submit"
          >
            {submitLabel}
          </Button>
        </>
      }
      initialFocus={nameRef}
      onOpenChange={onOpenChange}
      open={open}
      size="md"
      title={editing ? t("form.editTitle") : t("form.createTitle")}
    >
      <form
        aria-busy={mutation.isPending || undefined}
        className="flex flex-col gap-4"
        id={formId}
        noValidate
        onSubmit={onSubmit}
      >
        <Field>
          <FieldLabel>{t("form.name")}</FieldLabel>
          <Input
            autoComplete="off"
            onValueChange={(value) => set("name", value)}
            placeholder={t("form.namePlaceholder")}
            ref={nameRef}
            value={values.name}
          />
        </Field>
        <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
          <Field className="mb-2 sm:mb-0" invalid={limitsError}>
            <FieldLabel>{t("form.tokenLimit")}</FieldLabel>
            <NumberField
              aria-describedby={limitsDescribedBy}
              min={0}
              onValueChange={(value) => set("tokenLimit", value)}
              step={1}
              value={values.tokenLimit}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
          </Field>
          <Field invalid={limitsError}>
            <FieldLabel>{t("form.creditLimit")}</FieldLabel>
            <NumberField
              aria-describedby={limitsDescribedBy}
              min={0}
              onValueChange={(value) => set("creditLimit", value)}
              step={0.01}
              value={values.creditLimit}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
          </Field>
          <p className="text-muted-foreground text-xs sm:col-span-2">{t("form.limitsHint")}</p>
          {limitsError ? (
            <p
              className="text-destructive-foreground text-xs sm:col-span-2"
              id={limitsErrorId}
              role="alert"
            >
              {t("form.invalidLimits")}
            </p>
          ) : null}
        </div>
        <Field>
          <FieldLabel>{t("form.customKey")}</FieldLabel>
          <Input
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            onValueChange={(value) => set("key", value)}
            spellCheck={false}
            value={values.key}
          />
          <FieldDescription>
            {editing ? t("form.customKeyEditPlaceholder") : t("form.customKeyPlaceholder")}
          </FieldDescription>
        </Field>
        {mutation.isError ? (
          <Alert variant="error">
            <HugeiconsIcon icon={AlertCircleIcon} aria-hidden="true" />
            <AlertTitle>{editing ? t("form.saveFailed") : t("form.createFailed")}</AlertTitle>
            <AlertDescription className="break-words">
              {errorMessage(mutation.error, t)}
            </AlertDescription>
          </Alert>
        ) : null}
      </form>
    </ResponsiveDialog>
  );
}
