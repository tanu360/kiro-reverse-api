import {
  AlertCircleIcon,
  Key01Icon,
  KeyRoundIcon,
  Route01Icon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type FormEvent,
  type JSX,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import {
  ResponsiveSheet,
  ResponsiveSheetDescription,
  ResponsiveSheetFooter,
  ResponsiveSheetHeader,
  ResponsiveSheetPanel,
  ResponsiveSheetTitle,
} from "@/components/shared/responsive-sheet";
import { SectionCard } from "@/components/shared/section-card";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROUTING_MODE_LABEL, useRoutingMode } from "@/features/accounts/use-routing-mode";
import { createApiKey, updateApiKey } from "@/lib/api/api-keys";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/api/server-errors";
import type { ApiKey, ApiKeyRoutingMode } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { noSpaces } from "@/lib/input-filters";
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
  KEY_ROUTING_MODES,
  MAX_KEY_MODEL_LENGTH,
  MAX_KEY_MODELS,
  MAX_KEY_RPM,
  parseApiKeyForm,
} from "./api-key-form";
import { ExpiryPicker } from "./expiry-picker";
import { ModelPicker } from "./model-picker";
import { SheetMark } from "./sheet-mark";

export type ApiKeyDialogTarget = { mode: "create" } | { mode: "edit"; apiKey: ApiKey };

const CREDIT_FORMAT: Intl.NumberFormatOptions = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
};

const LIMIT_ERRORS: Readonly<Record<ApiKeyLimitField, string>> = {
  tokenLimit: "form.invalidTokenLimit",
  creditLimit: "form.invalidCreditLimit",
  callLimit: "form.invalidCallLimit",
  rpmLimit: "form.invalidRpmLimit",
};

type ModelsError = "noModels" | "tooManyModels" | "modelTooLong";

interface KeyForm {
  editing: boolean;
  values: ApiKeyFormValues;
  set: <K extends keyof ApiKeyFormValues>(field: K, value: ApiKeyFormValues[K]) => void;
  /** The one field that failed validation: only it turns red. */
  invalid: ApiKeyFormField | null;
  modelsError: ModelsError;
  refs: {
    name: RefObject<HTMLInputElement | null>;
  } & Record<ApiKeyFormField, RefObject<HTMLInputElement | null>>;
  formId: string;
  pending: boolean;
  error: unknown;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

/**
 * The form's state, request and validation, shared by the create dialog and the edit sheet. A
 * failed check marks its one field and focuses it.
 */
function useKeyForm(
  target: ApiKeyDialogTarget,
  onOpenChange: (open: boolean) => void,
  onCreated: (key: string) => void,
): KeyForm {
  const { t } = useT("api");
  const queryClient = useQueryClient();
  const editing = target.mode === "edit";
  const [values, setValues] = useState<ApiKeyFormValues>(() =>
    target.mode === "edit" ? formValuesFromKey(target.apiKey) : EMPTY_API_KEY_FORM,
  );
  // Base UI wires the failed field's FieldError into that input's aria-describedby.
  const [invalid, setInvalid] = useState<ApiKeyFormField | null>(null);
  const [modelsError, setModelsError] = useState<ModelsError>("noModels");
  // Bumped on each failed submit, so the effect focuses the field once it is rendered invalid.
  const [focusTick, setFocusTick] = useState(0);
  const refs = {
    name: useRef<HTMLInputElement>(null),
    tokenLimit: useRef<HTMLInputElement>(null),
    creditLimit: useRef<HTMLInputElement>(null),
    callLimit: useRef<HTMLInputElement>(null),
    rpmLimit: useRef<HTMLInputElement>(null),
    accountIds: useRef<HTMLInputElement>(null),
    allowedModels: useRef<HTMLInputElement>(null),
  };
  const formId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per failed submit.
  useEffect(() => {
    if (focusTick > 0 && invalid) refs[invalid].current?.focus();
  }, [focusTick]);

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
    if (field === "accountScope" && invalid === "accountIds") setInvalid(null);
    else if (field === "modelScope" && invalid === "allowedModels") setInvalid(null);
    else if (field === invalid) setInvalid(null);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.isPending) return;
    const parsed = parseApiKeyForm(values);
    if (!parsed.ok) {
      if (parsed.field === "allowedModels") setModelsError(parsed.error as ModelsError);
      setInvalid(parsed.field);
      // Straight to the bad field, so nobody has to hunt for the red one.
      setFocusTick((n) => n + 1);
      return;
    }
    mutation.mutate(parsed.value);
  };

  return {
    editing,
    values,
    set,
    invalid,
    modelsError,
    refs,
    formId,
    pending: mutation.isPending,
    error: mutation.isError ? mutation.error : null,
    onSubmit,
  };
}

/** Name and expiry side by side (stacked on phones). */
function NameAndExpiry({ form }: { form: KeyForm }): JSX.Element {
  const { t } = useT("api");
  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
      <Field>
        <FieldLabel>{t("form.name")}</FieldLabel>
        <Input
          maxLength={64}
          autoComplete="off"
          onValueChange={(value) => form.set("name", value)}
          placeholder={t("form.namePlaceholder")}
          ref={form.refs.name}
          value={form.values.name}
        />
      </Field>
      <ExpiryPicker
        onChange={(value) => form.set("expiresAt", value)}
        value={form.values.expiresAt}
      />
    </div>
  );
}

/** The custom key, with what an empty one means under it. */
function CustomKeyField({ form }: { form: KeyForm }): JSX.Element {
  const { t } = useT("api");
  return (
    <Field>
      <FieldLabel>{t("form.customKey")}</FieldLabel>
      <Input
        maxLength={128}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        onValueChange={(value) => form.set("key", noSpaces(value))}
        spellCheck={false}
        value={form.values.key}
      />
      <FieldDescription>
        {form.editing ? t("form.customKeyEditPlaceholder") : t("form.customKeyPlaceholder")}
      </FieldDescription>
    </Field>
  );
}

const LIMIT_LABELS: Readonly<Record<ApiKeyLimitField, string>> = {
  tokenLimit: "form.tokenLimit",
  creditLimit: "form.creditLimit",
  callLimit: "form.callLimit",
  rpmLimit: "form.rpmLimit",
};

/** One limit's number field, with its error when it is the failed one. */
function LimitField({ form, field }: { form: KeyForm; field: ApiKeyLimitField }): JSX.Element {
  const { t } = useT("api");
  return (
    <Field invalid={form.invalid === field}>
      <FieldLabel>{t(LIMIT_LABELS[field])}</FieldLabel>
      <NumberField
        // Two decimals for credits, as formatCredits shows them in the table and the cards.
        format={field === "creditLimit" ? CREDIT_FORMAT : undefined}
        max={field === "rpmLimit" ? MAX_KEY_RPM : undefined}
        min={0}
        onValueChange={(value) => form.set(field, value)}
        step={field === "creditLimit" ? 0.01 : 1}
        value={form.values[field]}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement />
          <NumberFieldInput ref={form.refs[field]} />
          <NumberFieldIncrement />
        </NumberFieldGroup>
      </NumberField>
      {form.invalid === field ? (
        <FieldError match role="alert">
          {t(LIMIT_ERRORS[field])}
        </FieldError>
      ) : null}
    </Field>
  );
}

/** Which accounts the key reaches; `hideLegend` where a card title already says "Accounts". */
function AccountsField({
  form,
  hideLegend = false,
}: {
  form: KeyForm;
  hideLegend?: boolean;
}): JSX.Element {
  return (
    <AccountPicker
      hideLegend={hideLegend}
      invalid={form.invalid === "accountIds"}
      onScopeChange={(scope) => form.set("accountScope", scope)}
      onSelectedChange={(ids) => form.set("accountIds", ids)}
      onTagsChange={(tags) => form.set("accountTags", tags)}
      scope={form.values.accountScope}
      searchRef={form.refs.accountIds}
      selected={form.values.accountIds}
      tags={form.values.accountTags}
    />
  );
}

/** The routing mode select, its hint under it. */
function RoutingField({ form }: { form: KeyForm }): JSX.Element {
  const { t } = useT("api");
  const globalMode = useRoutingMode();
  const routingItems = KEY_ROUTING_MODES.map((mode) => ({
    value: mode,
    label:
      mode === "inherit"
        ? t("form.routingInherit", { mode: t(ROUTING_MODE_LABEL[globalMode]) })
        : t(ROUTING_MODE_LABEL[mode]),
  }));
  return (
    <Field>
      <FieldLabel>{t("form.routingMode")}</FieldLabel>
      <Select
        items={routingItems}
        onValueChange={(next) => {
          if (KEY_ROUTING_MODES.includes(next as ApiKeyRoutingMode)) {
            form.set("routingMode", next as ApiKeyRoutingMode);
          }
        }}
        value={form.values.routingMode}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {routingItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <FieldDescription>{t("form.routingModeHint")}</FieldDescription>
    </Field>
  );
}

/** The models the key may call. */
function ModelsField({ form }: { form: KeyForm }): JSX.Element {
  const { t } = useT("api");
  const invalid =
    form.invalid !== "allowedModels"
      ? undefined
      : form.modelsError === "noModels"
        ? t("form.modelsRequired")
        : form.modelsError === "tooManyModels"
          ? t("form.tooManyModels", { max: MAX_KEY_MODELS })
          : t("form.modelTooLong", { max: MAX_KEY_MODEL_LENGTH });
  return (
    <ModelPicker
      invalid={invalid}
      onScopeChange={(scope) => form.set("modelScope", scope)}
      onSelectedChange={(models) => form.set("allowedModels", models)}
      scope={form.values.modelScope}
      searchRef={form.refs.allowedModels}
      selected={form.values.allowedModels}
    />
  );
}

/** A server error (duplicate key, collision, limits), inside the form. */
function ServerError({ form }: { form: KeyForm }): ReactNode {
  const { t } = useT("api");
  if (!form.error) return null;
  return (
    <Alert variant="error">
      <HugeiconsIcon icon={AlertCircleIcon} aria-hidden="true" />
      <AlertTitle>{form.editing ? t("form.saveFailed") : t("form.createFailed")}</AlertTitle>
      <AlertDescription className="wrap-break-word">{errorMessage(form.error, t)}</AlertDescription>
    </Alert>
  );
}

function FormActions({ form, onCancel }: { form: KeyForm; onCancel: () => void }): JSX.Element {
  const { t } = useT("api");
  return (
    <>
      <Button onClick={onCancel} variant="ghost">
        {t("common:actions.cancel")}
      </Button>
      <Button
        form={form.formId}
        loading={form.pending}
        loadingText={form.editing ? t("common:actions.saving") : t("form.submitCreating")}
        type="submit"
      >
        {form.editing ? t("common:actions.save") : t("form.submitCreate")}
      </Button>
    </>
  );
}

/**
 * Create: the app's dialog at its default width, one form: name and expiry, then the token, call
 * and per-minute limits on one line, the accounts, the credit limit beside the routing mode, the
 * models and the custom key.
 */
function ApiKeyCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: string) => void;
}): JSX.Element {
  const { t } = useT("api");
  const form = useKeyForm({ mode: "create" }, onOpenChange, onCreated);

  return (
    <ResponsiveDialog
      footer={<FormActions form={form} onCancel={() => onOpenChange(false)} />}
      initialFocus={form.refs.name}
      onOpenChange={onOpenChange}
      open={open}
      title={t("form.createTitle")}
    >
      <form
        aria-busy={form.pending || undefined}
        className="flex flex-col gap-4"
        id={form.formId}
        noValidate
        onSubmit={form.onSubmit}
      >
        <NameAndExpiry form={form} />
        <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-3">
          <LimitField field="tokenLimit" form={form} />
          <LimitField field="callLimit" form={form} />
          <LimitField field="rpmLimit" form={form} />
          <FieldHint className="sm:col-span-3">{t("form.limitsHint")}</FieldHint>
        </div>
        <AccountsField form={form} />
        <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
          <LimitField field="creditLimit" form={form} />
          <RoutingField form={form} />
        </div>
        <ModelsField form={form} />
        <CustomKeyField form={form} />
        <ServerError form={form} />
      </form>
    </ResponsiveDialog>
  );
}

/**
 * Edit: the detail sheet the account and usage sheets use: the key's mark on the avatar tile, the
 * title and the masked key, then one card per part (General, Accounts, Routing & models), with
 * Cancel and Save in the sheet's foot.
 */
function ApiKeyEditSheet({
  open,
  apiKey,
  onOpenChange,
}: {
  open: boolean;
  apiKey: ApiKey;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { t } = useT("api");
  const form = useKeyForm({ mode: "edit", apiKey }, onOpenChange, () => {});

  return (
    <ResponsiveSheet onOpenChange={onOpenChange} open={open}>
      <ResponsiveSheetHeader>
        <div className="flex items-start gap-3">
          <SheetMark icon={KeyRoundIcon} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <ResponsiveSheetTitle className="truncate">{t("form.editTitle")}</ResponsiveSheetTitle>
            {apiKey.keyMasked ? (
              <ResponsiveSheetDescription className="min-w-0 truncate font-mono">
                {apiKey.keyMasked}
              </ResponsiveSheetDescription>
            ) : null}
          </div>
        </div>
      </ResponsiveSheetHeader>
      <ResponsiveSheetPanel>
        <form
          aria-busy={form.pending || undefined}
          className="flex flex-col gap-4"
          id={form.formId}
          noValidate
          onSubmit={form.onSubmit}
        >
          <SectionCard
            icon={Key01Icon}
            panelClassName="flex flex-col gap-4"
            title={t("form.tabGeneral")}
          >
            <NameAndExpiry form={form} />
            <CustomKeyField form={form} />
            <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
              <LimitField field="tokenLimit" form={form} />
              <LimitField field="creditLimit" form={form} />
              <LimitField field="callLimit" form={form} />
              <LimitField field="rpmLimit" form={form} />
              <FieldHint className="sm:col-span-2">{t("form.limitsHint")}</FieldHint>
            </div>
          </SectionCard>
          <SectionCard icon={UserMultipleIcon} title={t("form.accounts")}>
            <AccountsField form={form} hideLegend />
          </SectionCard>
          <SectionCard
            icon={Route01Icon}
            panelClassName="flex flex-col gap-4"
            title={t("form.tabRouting")}
          >
            <RoutingField form={form} />
            <ModelsField form={form} />
          </SectionCard>
          <ServerError form={form} />
        </form>
      </ResponsiveSheetPanel>
      <ResponsiveSheetFooter className="justify-end">
        <FormActions form={form} onCancel={() => onOpenChange(false)} />
      </ResponsiveSheetFooter>
    </ResponsiveSheet>
  );
}

/**
 * Create opens the dialog, edit the sheet. The parent remounts it for every opening, so each one
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
  return target.mode === "edit" ? (
    <ApiKeyEditSheet apiKey={target.apiKey} onOpenChange={onOpenChange} open={open} />
  ) : (
    <ApiKeyCreateDialog onCreated={onCreated} onOpenChange={onOpenChange} open={open} />
  );
}
