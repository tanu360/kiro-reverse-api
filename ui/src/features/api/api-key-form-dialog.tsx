import {
  AlertCircleIcon,
  Key01Icon,
  KeyRoundIcon,
  Route01Icon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { SettingsRow } from "@/components/shared/settings-rows";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogPanel } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldHint, FieldLabel } from "@/components/ui/field";
import { Fieldset, FieldsetLegend } from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROUTING_MODE_LABEL, useRoutingMode } from "@/features/accounts/use-routing-mode";
import { accountsQuery } from "@/lib/api/accounts";
import { createApiKey, keyModelsQuery, updateApiKey } from "@/lib/api/api-keys";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/api/server-errors";
import type { ApiKey, ApiKeyRoutingMode } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { noSpaces } from "@/lib/input-filters";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { AccountPicker, AccountPicks } from "./account-picker";
import {
  type ApiKeyFormData,
  type ApiKeyFormFailure,
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
import { ModelPicker, ModelPicks } from "./model-picker";
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
  /** Marks the failed field and focuses it once it is on screen. */
  reject: (failure: ApiKeyFormFailure) => void;
  /** Sends the checked values. */
  submit: (data: ApiKeyFormData) => void;
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

  const reject = (failure: ApiKeyFormFailure) => {
    if (failure.field === "allowedModels") setModelsError(failure.error as ModelsError);
    setInvalid(failure.field);
    // Straight to the bad field, so nobody has to hunt for the red one.
    setFocusTick((n) => n + 1);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.isPending) return;
    const parsed = parseApiKeyForm(values);
    if (!parsed.ok) reject(parsed);
    else mutation.mutate(parsed.value);
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
    reject,
    submit: (data) => mutation.mutate(data),
    onSubmit,
  };
}

/** The key's name, its label above it. */
function NameField({ form }: { form: KeyForm }): JSX.Element {
  const { t } = useT("api");
  return (
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
  );
}

/** Name and expiry side by side (stacked on phones). */
function NameAndExpiry({ form }: { form: KeyForm }): JSX.Element {
  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
      <NameField form={form} />
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

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/** One limit's number field; a settings row's title and description go on its input. */
function LimitNumber({
  form,
  field,
  id,
  ...aria
}: AriaProps & { form: KeyForm; field: ApiKeyLimitField; id?: string }): JSX.Element {
  return (
    <NumberField
      // Two decimals for credits, as formatCredits shows them in the table and the cards.
      format={field === "creditLimit" ? CREDIT_FORMAT : undefined}
      id={id}
      max={field === "rpmLimit" ? MAX_KEY_RPM : undefined}
      min={0}
      onValueChange={(value) => form.set(field, value)}
      step={field === "creditLimit" ? 0.01 : 1}
      value={form.values[field]}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement />
        <NumberFieldInput ref={form.refs[field]} {...aria} />
        <NumberFieldIncrement />
      </NumberFieldGroup>
    </NumberField>
  );
}

/** The limit's error, when it is the failed one. */
function LimitError({ form, field }: { form: KeyForm; field: ApiKeyLimitField }): ReactNode {
  const { t } = useT("api");
  if (form.invalid !== field) return null;
  return (
    <FieldError match role="alert">
      {t(LIMIT_ERRORS[field])}
    </FieldError>
  );
}

/** One limit's number field, with its error when it is the failed one. */
function LimitField({ form, field }: { form: KeyForm; field: ApiKeyLimitField }): JSX.Element {
  const { t } = useT("api");
  return (
    <Field invalid={form.invalid === field}>
      <FieldLabel>{t(LIMIT_LABELS[field])}</FieldLabel>
      <LimitNumber field={field} form={form} />
      <LimitError field={field} form={form} />
    </Field>
  );
}

/** The four limits two by two, with what 0 means under them. */
function LimitsGrid({ form }: { form: KeyForm }): JSX.Element {
  const { t } = useT("api");
  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
      <LimitField field="tokenLimit" form={form} />
      <LimitField field="creditLimit" form={form} />
      <LimitField field="callLimit" form={form} />
      <LimitField field="rpmLimit" form={form} />
      <FieldHint className="sm:col-span-2">{t("form.limitsHint")}</FieldHint>
    </div>
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

/** The routing mode select; a settings row's title and description go on its trigger. */
function RoutingSelect({ form, ...aria }: AriaProps & { form: KeyForm }): JSX.Element {
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
    <Select
      items={routingItems}
      onValueChange={(next) => {
        if (KEY_ROUTING_MODES.includes(next as ApiKeyRoutingMode)) {
          form.set("routingMode", next as ApiKeyRoutingMode);
        }
      }}
      value={form.values.routingMode}
    >
      <SelectTrigger {...aria}>
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
  );
}

/** The routing mode select, its hint under it. */
function RoutingField({ form }: { form: KeyForm }): JSX.Element {
  const { t } = useT("api");
  return (
    <Field>
      <FieldLabel>{t("form.routingMode")}</FieldLabel>
      <RoutingSelect form={form} />
      <FieldDescription>{t("form.routingModeHint")}</FieldDescription>
    </Field>
  );
}

/** Why the models were refused, when they are the failed field. */
function useModelsError(form: KeyForm): string | undefined {
  const { t } = useT("api");
  if (form.invalid !== "allowedModels") return undefined;
  if (form.modelsError === "noModels") return t("form.modelsRequired");
  if (form.modelsError === "tooManyModels") return t("form.tooManyModels", { max: MAX_KEY_MODELS });
  return t("form.modelTooLong", { max: MAX_KEY_MODEL_LENGTH });
}

/** The models the key may call. */
function ModelsField({ form }: { form: KeyForm }): JSX.Element {
  const invalid = useModelsError(form);
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

/** All or Only selected, as a segmented switch filling a settings row's control slot. */
function ScopeSwitch<T extends string>({
  value,
  onChange,
  options,
  ...aria
}: AriaProps & {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}): JSX.Element {
  return (
    <SegmentedControl
      className="w-full"
      render={<RadioGroupPrimitive onValueChange={(next) => onChange(next as T)} value={value} />}
      {...aria}
    >
      {options.map((option) => (
        <SegmentedControlItem
          className="flex-1"
          key={option.value}
          render={<RadioPrimitive.Root value={option.value} />}
        >
          {option.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

/*
 * The create rows sit straight in the dialog, which is their card: no box round them, the
 * dialog's padding as theirs (px-0), and the cards' hairline (border-subtle) between them.
 */
const ROW_LIST = "flex min-w-0 flex-col divide-y divide-border-subtle";
const ROW = "px-0";

/** Create, step 1: name, expiry and custom key as rows, then the four limits under a legend. */
function BasicsRows({ form }: { form: KeyForm }): JSX.Element {
  const { t } = useT("api");
  const nameId = useId();
  const keyId = useId();
  return (
    <>
      <div className={ROW_LIST}>
        <SettingsRow
          className={ROW}
          compact
          control={
            <Input
              maxLength={64}
              autoComplete="off"
              id={nameId}
              onValueChange={(value) => form.set("name", value)}
              placeholder={t("form.namePlaceholder")}
              ref={form.refs.name}
              value={form.values.name}
            />
          }
          htmlFor={nameId}
          title={t("form.name")}
        />
        <SettingsRow
          className={ROW}
          compact
          control={
            <ExpiryPicker
              bare
              onChange={(value) => form.set("expiresAt", value)}
              value={form.values.expiresAt}
            />
          }
          description={t("form.expiresAtRowHint")}
          title={t("form.expiresAt")}
        />
        <SettingsRow
          className={ROW}
          compact
          control={
            <Input
              maxLength={128}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              id={keyId}
              onValueChange={(value) => form.set("key", noSpaces(value))}
              spellCheck={false}
              value={form.values.key}
            />
          }
          description={t("form.customKeyPlaceholder")}
          htmlFor={keyId}
          title={t("form.customKey")}
        />
      </div>
      <Fieldset className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <FieldsetLegend>{t("form.limits")}</FieldsetLegend>
          <FieldHint>{t("form.limitsHint")}</FieldHint>
        </div>
        <div className={ROW_LIST}>
          {LIMIT_FIELDS.map((field) => (
            <LimitRow field={field} form={form} key={field} />
          ))}
        </div>
      </Fieldset>
    </>
  );
}

const LIMIT_FIELDS: readonly ApiKeyLimitField[] = [
  "tokenLimit",
  "creditLimit",
  "callLimit",
  "rpmLimit",
];

/** One limit as a settings row, its error under the title. */
function LimitRow({ form, field }: { form: KeyForm; field: ApiKeyLimitField }): JSX.Element {
  const { t } = useT("api");
  const id = useId();
  return (
    // One Field round the row: it marks the input invalid and ties the error to it.
    <Field className="items-stretch" invalid={form.invalid === field}>
      <SettingsRow
        className={ROW}
        compact
        control={<LimitNumber field={field} form={form} id={id} />}
        controlWidth="number"
        htmlFor={id}
        title={t(LIMIT_LABELS[field])}
      >
        <LimitError field={field} form={form} />
      </SettingsRow>
    </Field>
  );
}

/**
 * Create, step 2: the routing mode, the models and the accounts as rows; Only selected opens
 * its picks under its row.
 */
function AccessRows({ form }: { form: KeyForm }): JSX.Element {
  const { t } = useT("api");
  const modelsError = useModelsError(form);
  // Loads both lists while All is chosen, so Only selected opens on them.
  useQuery(keyModelsQuery());
  useQuery(accountsQuery());
  return (
    <div className={ROW_LIST}>
      <SettingsRow
        className={ROW}
        compact
        control={<RoutingSelect form={form} />}
        // Under the text: "Same as Settings (Reset first)" is too long to sit beside it.
        controlWidth="block"
        description={t("form.routingModeShort")}
        title={t("form.routingMode")}
      />
      {/* A row and the picks it opens share one item, so no hairline parts them. */}
      <div>
        <SettingsRow
          className={ROW}
          compact
          control={
            <ScopeSwitch
              onChange={(scope) => form.set("modelScope", scope)}
              options={[
                { value: "all", label: t("form.modelsAll") },
                { value: "selected", label: t("form.scopeSelected") },
              ]}
              value={form.values.modelScope}
            />
          }
          description={t("form.allowedModelsShort")}
          title={t("form.allowedModels")}
        />
        {form.values.modelScope === "selected" ? (
          <div className="pb-3">
            <ModelPicks
              invalid={modelsError}
              onSelectedChange={(models) => form.set("allowedModels", models)}
              searchRef={form.refs.allowedModels}
              selected={form.values.allowedModels}
            />
          </div>
        ) : null}
      </div>
      <div>
        <SettingsRow
          className={ROW}
          compact
          control={
            <ScopeSwitch
              onChange={(scope) => form.set("accountScope", scope)}
              options={[
                { value: "all", label: t("form.accountsAll") },
                { value: "selected", label: t("form.scopeSelected") },
              ]}
              value={form.values.accountScope}
            />
          }
          description={t("form.accountsShort")}
          title={t("form.accounts")}
        />
        {form.values.accountScope === "selected" ? (
          <div className="pb-3">
            <AccountPicks
              invalid={form.invalid === "accountIds"}
              onSelectedChange={(ids) => form.set("accountIds", ids)}
              onTagsChange={(tags) => form.set("accountTags", tags)}
              searchRef={form.refs.accountIds}
              selected={form.values.accountIds}
              tags={form.values.accountTags}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The create wizard's steps, in order. */
const CREATE_STEPS = ["form.stepBasics", "form.stepAccess"] as const;
const LAST_STEP = CREATE_STEPS.length - 1;

/** The step each checked field sits on, so a failed check goes back to it. */
const FIELD_STEP: Readonly<Record<ApiKeyFormField, number>> = {
  tokenLimit: 0,
  creditLimit: 0,
  callLimit: 0,
  rpmLimit: 0,
  accountIds: 1,
  allowedModels: 1,
};

/**
 * Create: the app's dialog at its default width, in two steps of settings rows (the Settings
 * page's own, straight in the dialog): Basics (name, expiry, custom key and the limits), then
 * Access (routing mode, models, accounts). Next checks the fields up to the
 * current step; the last step creates the key. Both steps share one body height, so the dialog
 * keeps its size between them, and a longer step scrolls inside it.
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
  const [step, setStep] = useState(0);
  const stepRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  // Where focus goes once a step change removed the focused element: the new step's first field
  // after Enter in a field, Next after Back leaves the first step (where Back is gone).
  const refocus = useRef<"field" | "next" | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per step change.
  useEffect(() => {
    const target = refocus.current;
    refocus.current = null;
    if (target === "next") nextRef.current?.focus();
    else if (target === "field") {
      const first =
        step === 0
          ? form.refs.name.current
          : stepRef.current?.querySelector<HTMLElement>('[role="combobox"]');
      first?.focus();
    }
  }, [step]);

  const goTo = (next: number) => {
    const active = document.activeElement;
    if (stepRef.current?.contains(active)) refocus.current = "field";
    else if (next === 0 && active === backRef.current) refocus.current = "next";
    setStep(next);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form.pending) return;
    const parsed = parseApiKeyForm(form.values);
    if (!parsed.ok && FIELD_STEP[parsed.field] <= step) {
      setStep(FIELD_STEP[parsed.field]);
      form.reject(parsed);
      return;
    }
    if (step < LAST_STEP) goTo(step + 1);
    else if (parsed.ok) form.submit(parsed.value);
  };

  const last = step === LAST_STEP;
  return (
    <ResponsiveDialog
      anchor="top"
      description={t("form.stepOf", {
        step: step + 1,
        total: CREATE_STEPS.length,
        name: t(CREATE_STEPS[step] ?? CREATE_STEPS[0]),
      })}
      footer={
        <>
          <Button
            className="sm:me-auto"
            key="cancel"
            onClick={() => onOpenChange(false)}
            variant="ghost"
          >
            {t("common:actions.cancel")}
          </Button>
          {step > 0 ? (
            <Button
              disabled={form.pending}
              key="back"
              onClick={() => goTo(step - 1)}
              ref={backRef}
              variant="outline"
            >
              {t("common:actions.back")}
            </Button>
          ) : null}
          <Button
            form={form.formId}
            key="next"
            loading={form.pending}
            loadingText={t("form.submitCreating")}
            ref={nextRef}
            type="submit"
          >
            {last ? t("form.submitCreate") : t("common:actions.next")}
          </Button>
        </>
      }
      initialFocus={form.refs.name}
      onOpenChange={onOpenChange}
      open={open}
      panel={false}
      title={t("form.createTitle")}
    >
      {/* One bar per step, done and current ones filled; the description names the step. */}
      <div aria-hidden="true" className="flex gap-2 px-4 pb-3">
        {CREATE_STEPS.map((name, index) => (
          <span
            className={cn(
              "h-1 flex-1 rounded-full",
              index <= step ? "bg-primary" : "bg-chart-scale-01",
            )}
            key={name}
          />
        ))}
      </div>
      {/* One height from sm up for both steps, so Next and Back never resize the dialog. */}
      <div className="flex min-h-0 flex-1 flex-col sm:h-140 sm:flex-initial">
        <DialogPanel>
          <form
            aria-busy={form.pending || undefined}
            className="flex flex-col gap-4"
            id={form.formId}
            noValidate
            onSubmit={onSubmit}
          >
            <div className="flex flex-col gap-4" ref={stepRef}>
              {step === 0 ? <BasicsRows form={form} /> : <AccessRows form={form} />}
            </div>
            {last ? <ServerError form={form} /> : null}
          </form>
        </DialogPanel>
      </div>
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
            <LimitsGrid form={form} />
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
