import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type JSX, useId, useRef, useState } from "react";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldHint, FieldLabel } from "@/components/ui/field";
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
import { AccountPicker } from "./account-picker";
import {
  type ApiKeyFormData,
  type ApiKeyFormField,
  type ApiKeyFormValues,
  type ApiKeyLimitField,
  buildCreateRequest,
  buildUpdateRequest,
  EMPTY_API_KEY_FORM,
  formValuesFromKey,
  parseApiKeyForm,
} from "./api-key-form";

export type ApiKeyDialogTarget = { mode: "create" } | { mode: "edit"; apiKey: ApiKey };

const CREDIT_FORMAT: Intl.NumberFormatOptions = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
};

const LIMIT_ERRORS: Readonly<Record<ApiKeyLimitField, string>> = {
  tokenLimit: "form.invalidTokenLimit",
  creditLimit: "form.invalidCreditLimit",
  callLimit: "form.invalidCallLimit",
};

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
  // The one field that failed validation: only it turns red, and Base UI wires its
  // FieldError into that input's aria-describedby.
  const [limitsError, setLimitsError] = useState<ApiKeyFormField | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const tokenLimitRef = useRef<HTMLInputElement>(null);
  const creditLimitRef = useRef<HTMLInputElement>(null);
  const callLimitRef = useRef<HTMLInputElement>(null);
  const accountSearchRef = useRef<HTMLInputElement>(null);
  const fieldRefs = {
    tokenLimit: tokenLimitRef,
    creditLimit: creditLimitRef,
    callLimit: callLimitRef,
    accountIds: accountSearchRef,
  } as const;
  const formId = useId();

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
    if (field === "accountScope") setLimitsError(null);
    else if (field === limitsError) setLimitsError(null);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.isPending) return;
    const parsed = parseApiKeyForm(values);
    if (!parsed.ok) {
      setLimitsError(parsed.field);
      // Straight to the bad field, so nobody has to hunt for the red one.
      fieldRefs[parsed.field].current?.focus();
      return;
    }
    mutation.mutate(parsed.value);
  };

  const limitError = (field: ApiKeyLimitField) =>
    limitsError === field ? (
      <FieldError match role="alert">
        {t(LIMIT_ERRORS[field])}
      </FieldError>
    ) : null;
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
          <Field className="mb-2 sm:mb-0" invalid={limitsError === "tokenLimit"}>
            <FieldLabel>{t("form.tokenLimit")}</FieldLabel>
            <NumberField
              min={0}
              onValueChange={(value) => set("tokenLimit", value)}
              step={1}
              value={values.tokenLimit}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput ref={tokenLimitRef} />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
            {limitError("tokenLimit")}
          </Field>
          <Field invalid={limitsError === "creditLimit"}>
            <FieldLabel>{t("form.creditLimit")}</FieldLabel>
            {/* Two decimals, as formatCredits shows credits in the table and the cards. */}
            <NumberField
              format={CREDIT_FORMAT}
              min={0}
              onValueChange={(value) => set("creditLimit", value)}
              step={0.01}
              value={values.creditLimit}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput ref={creditLimitRef} />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
            {limitError("creditLimit")}
          </Field>
          <Field className="mt-2" invalid={limitsError === "callLimit"}>
            <FieldLabel>{t("form.callLimit")}</FieldLabel>
            <NumberField
              min={0}
              onValueChange={(value) => set("callLimit", value)}
              step={1}
              value={values.callLimit}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput ref={callLimitRef} />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
            {limitError("callLimit")}
          </Field>
          <FieldHint className="sm:col-span-2">{t("form.limitsHint")}</FieldHint>
        </div>
        <AccountPicker
          invalid={limitsError === "accountIds"}
          onScopeChange={(scope) => set("accountScope", scope)}
          onSelectedChange={(ids) => set("accountIds", ids)}
          scope={values.accountScope}
          searchRef={accountSearchRef}
          selected={values.accountIds}
        />
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
            <AlertDescription className="wrap-break-word">
              {errorMessage(mutation.error, t)}
            </AlertDescription>
          </Alert>
        ) : null}
      </form>
    </ResponsiveDialog>
  );
}
