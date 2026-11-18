import {
  CheckIcon,
  DashboardSpeed01Icon,
  Key01Icon,
  KeyRoundIcon,
  ShieldKeyIcon,
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
import { ActionError } from "@/components/shared/action-error";
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
import { SETTINGS_ROW_X, SettingsRow } from "@/components/shared/settings-rows";
import { Button } from "@/components/ui/button";
import { DialogPanel } from "@/components/ui/dialog";
import { Field, FieldError, FieldHint } from "@/components/ui/field";
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
import { announce } from "@/lib/announce";
import { accountsQuery } from "@/lib/api/accounts";
import { createApiKey, keyModelsQuery, updateApiKey } from "@/lib/api/api-keys";
import { queryKeys } from "@/lib/api/query-keys";
import type { ApiKey, ApiKeyRoutingMode } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { noSpaces } from "@/lib/input-filters";
import { cn } from "@/lib/utils";
import { AccountPicks } from "./account-picker";
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
import { ModelPicks } from "./model-picker";
import { SheetMark } from "./sheet-mark";

export type ApiKeyDialogTarget = { mode: "create" } | { mode: "edit"; apiKey: ApiKey };

/** How long the edit sheet's Save reads "Saved" before the sheet closes. */
export const SAVED_CLOSE_MS = 700;

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
  /** Edit only: saved, and the sheet closes in a moment (Save reads "Saved"). */
  saved: boolean;
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
  const [saved, setSaved] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

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
    // No toast. Create closes at once on the new-key panel (an alert, read out as it shows);
    // edit reads "Saved" on its Save for a moment, then closes on the updated row.
    onSuccess: (createdKey) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
      if (createdKey) {
        onCreated(createdKey);
        onOpenChange(false);
        return;
      }
      setSaved(true);
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null;
        onOpenChange(false);
        announce(t("form.updated"));
      }, SAVED_CLOSE_MS);
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
    if (mutation.isPending || saved) return;
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
    saved,
    error: mutation.isError ? mutation.error : null,
    reject,
    submit: (data) => mutation.mutate(data),
    onSubmit,
  };
}

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/**
 * Where a row sits: straight in the create dialog, whose padding is its own (no inline padding
 * of the row's), or in one of the edit sheet's cards, which leave the row its 16 px.
 */
type RowPlace = "dialog" | "card";

const rowClass = (place: RowPlace): string | undefined => (place === "dialog" ? "px-0" : undefined);

/** A list opened under its row: the row's inline padding, 12 px below it. */
const picksClass = (place: RowPlace): string => cn("pb-3", place === "card" && SETTINGS_ROW_X);

/** The key's name. */
function NameRow({ form, place }: { form: KeyForm; place: RowPlace }): JSX.Element {
  const { t } = useT("api");
  const id = useId();
  return (
    <SettingsRow
      className={rowClass(place)}
      compact
      control={
        <Input
          maxLength={64}
          autoComplete="off"
          id={id}
          onValueChange={(value) => form.set("name", value)}
          placeholder={t("form.namePlaceholder")}
          ref={form.refs.name}
          value={form.values.name}
        />
      }
      htmlFor={id}
      title={t("form.name")}
    />
  );
}

/** When the key stops working; a stored day that has passed (edit) says so instead of the hint. */
function ExpiresRow({ form, place }: { form: KeyForm; place: RowPlace }): JSX.Element {
  const { t } = useT("api");
  const { expiresAt } = form.values;
  const past = expiresAt > 0 && expiresAt <= Math.floor(Date.now() / 1000);
  return (
    <SettingsRow
      className={rowClass(place)}
      compact
      control={
        <ExpiryPicker onChange={(value) => form.set("expiresAt", value)} value={expiresAt} />
      }
      description={past ? t("form.expiresAtPast") : t("form.expiresAtRowHint")}
      title={t("form.expiresAt")}
    />
  );
}

/** A key of the user's own; empty generates one (create) or keeps the current one (edit). */
function CustomKeyRow({ form, place }: { form: KeyForm; place: RowPlace }): JSX.Element {
  const { t } = useT("api");
  const id = useId();
  return (
    <SettingsRow
      className={rowClass(place)}
      compact
      control={
        <Input
          maxLength={128}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          id={id}
          onValueChange={(value) => form.set("key", noSpaces(value))}
          spellCheck={false}
          value={form.values.key}
        />
      }
      description={
        form.editing ? t("form.customKeyEditPlaceholder") : t("form.customKeyPlaceholder")
      }
      htmlFor={id}
      title={t("form.customKey")}
    />
  );
}

const LIMIT_LABELS: Readonly<Record<ApiKeyLimitField, string>> = {
  tokenLimit: "form.tokenLimit",
  creditLimit: "form.creditLimit",
  callLimit: "form.callLimit",
  rpmLimit: "form.rpmLimit",
};

const LIMIT_FIELDS: readonly ApiKeyLimitField[] = [
  "tokenLimit",
  "creditLimit",
  "callLimit",
  "rpmLimit",
];

/** One limit's number field; the row's title and description go on its input. */
function LimitNumber({
  form,
  field,
  id,
  ...aria
}: AriaProps & { form: KeyForm; field: ApiKeyLimitField; id: string }): JSX.Element {
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

/** One limit, its error under the title when it is the failed one. */
function LimitRow({
  form,
  field,
  place,
}: {
  form: KeyForm;
  field: ApiKeyLimitField;
  place: RowPlace;
}): JSX.Element {
  const { t } = useT("api");
  const id = useId();
  return (
    // One Field round the row: it marks the input invalid and ties the error to it.
    <Field className="items-stretch" invalid={form.invalid === field}>
      <SettingsRow
        className={rowClass(place)}
        compact
        control={<LimitNumber field={field} form={form} id={id} />}
        controlWidth="number"
        htmlFor={id}
        title={t(LIMIT_LABELS[field])}
      >
        {form.invalid === field ? (
          <FieldError match role="alert">
            {t(LIMIT_ERRORS[field])}
          </FieldError>
        ) : null}
      </SettingsRow>
    </Field>
  );
}

/** The routing mode select; the row's title and description go on its trigger. */
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

/** How the key's requests pick an account; the select under the text, at the row's width. */
function RoutingRow({ form, place }: { form: KeyForm; place: RowPlace }): JSX.Element {
  const { t } = useT("api");
  return (
    <SettingsRow
      className={rowClass(place)}
      compact
      control={<RoutingSelect form={form} />}
      // Under the text: "Same as Settings (Reset first)" is too long to sit beside it.
      controlWidth="block"
      description={t("form.routingModeShort")}
      title={t("form.routingMode")}
    />
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

/** Why the models were refused, when they are the failed field. */
function useModelsError(form: KeyForm): string | undefined {
  const { t } = useT("api");
  if (form.invalid !== "allowedModels") return undefined;
  if (form.modelsError === "noModels") return t("form.modelsRequired");
  if (form.modelsError === "tooManyModels") return t("form.tooManyModels", { max: MAX_KEY_MODELS });
  return t("form.modelTooLong", { max: MAX_KEY_MODEL_LENGTH });
}

/**
 * The models the key may call: every model, or the ticked ones, listed under the row. The row
 * and its list are one item, so no hairline parts them.
 */
function ModelsRow({ form, place }: { form: KeyForm; place: RowPlace }): JSX.Element {
  const { t } = useT("api");
  const invalid = useModelsError(form);
  return (
    <div>
      <SettingsRow
        className={rowClass(place)}
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
        <div className={picksClass(place)}>
          <ModelPicks
            invalid={invalid}
            onSelectedChange={(models) => form.set("allowedModels", models)}
            searchRef={form.refs.allowedModels}
            selected={form.values.allowedModels}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The accounts the key's requests use: all, or the picked ones and tags, listed under the row. */
function AccountsRow({ form, place }: { form: KeyForm; place: RowPlace }): JSX.Element {
  const { t } = useT("api");
  return (
    <div>
      <SettingsRow
        className={rowClass(place)}
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
        <div className={picksClass(place)}>
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
  );
}

/** Loads the model and account lists while All is chosen, so Only selected opens on them. */
function usePickLists(): void {
  useQuery(keyModelsQuery());
  useQuery(accountsQuery());
}

/**
 * A server error (duplicate key, collision, limits), inside the form, as the page's other
 * failures show: one line, brought into view (it sits at the end of a long scrolling form, and
 * on a phone Save would just stop spinning with it out of sight). Save is the retry.
 */
function ServerError({ form }: { form: KeyForm }): ReactNode {
  return form.error ? <ActionError error={form.error} /> : null;
}

/*
 * The create rows sit straight in the dialog, which is their card: no box round them, and the
 * cards' hairline (border-subtle) between them.
 */
const ROW_LIST = "flex min-w-0 flex-col divide-y divide-border-subtle";

/** Create, step 1: name, expiry and custom key as rows, then the four limits under a legend. */
function BasicsRows({ form }: { form: KeyForm }): JSX.Element {
  const { t } = useT("api");
  return (
    <>
      <div className={ROW_LIST}>
        <NameRow form={form} place="dialog" />
        <ExpiresRow form={form} place="dialog" />
        <CustomKeyRow form={form} place="dialog" />
      </div>
      <Fieldset className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <FieldsetLegend>{t("form.limits")}</FieldsetLegend>
          <FieldHint>{t("form.limitsHint")}</FieldHint>
        </div>
        <div className={ROW_LIST}>
          {LIMIT_FIELDS.map((field) => (
            <LimitRow field={field} form={form} key={field} place="dialog" />
          ))}
        </div>
      </Fieldset>
    </>
  );
}

/** Create, step 2: the routing mode, the models and the accounts as rows. */
function AccessRows({ form }: { form: KeyForm }): JSX.Element {
  usePickLists();
  return (
    <div className={ROW_LIST}>
      <RoutingRow form={form} place="dialog" />
      <ModelsRow form={form} place="dialog" />
      <AccountsRow form={form} place="dialog" />
    </div>
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
        // Saved: the sheet closes in a moment; Save keeps focus and full strength meanwhile.
        aria-disabled={form.saved || undefined}
        className={cn(form.saved && "aria-disabled:not-aria-busy:opacity-100")}
        form={form.formId}
        loading={form.pending}
        loadingText={form.editing ? t("common:actions.saving") : t("form.submitCreating")}
        type="submit"
      >
        {form.saved ? (
          <>
            <HugeiconsIcon icon={CheckIcon} aria-hidden="true" />
            {t("common:actions.saved")}
          </>
        ) : form.editing ? (
          t("common:actions.save")
        ) : (
          t("form.submitCreate")
        )}
      </Button>
    </>
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
          <Button
            // Last in the markup, first on screen. On a phone after step 1 it gives way (the X
            // still closes), so Back and Create share the footer's one row; the footer's
            // odd-last-child span then falls on this hidden button.
            className={cn("order-first sm:me-auto", step > 0 && "max-sm:hidden")}
            key="cancel"
            onClick={() => onOpenChange(false)}
            variant="ghost"
          >
            {t("common:actions.cancel")}
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
      <div className="flex min-h-0 flex-1 flex-col sm:h-134 sm:flex-initial">
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
 * title and the masked key, then one card per part (General, Limits, Access) holding the create
 * dialog's rows, with Cancel and Save in the sheet's foot.
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
  usePickLists();

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
          <SectionCard icon={Key01Icon} slim title={t("form.tabGeneral")}>
            <NameRow form={form} place="card" />
            <ExpiresRow form={form} place="card" />
            <CustomKeyRow form={form} place="card" />
          </SectionCard>
          <SectionCard
            description={t("form.limitsHint")}
            descriptionVariant="inline"
            icon={DashboardSpeed01Icon}
            slim
            title={t("form.limits")}
          >
            {LIMIT_FIELDS.map((field) => (
              <LimitRow field={field} form={form} key={field} place="card" />
            ))}
          </SectionCard>
          <SectionCard icon={ShieldKeyIcon} slim title={t("form.stepAccess")}>
            <RoutingRow form={form} place="card" />
            <ModelsRow form={form} place="card" />
            <AccountsRow form={form} place="card" />
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
