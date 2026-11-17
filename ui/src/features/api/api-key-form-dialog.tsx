import {
  AlertCircleIcon,
  DashboardSpeed02Icon,
  Key01Icon,
  Route01Icon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { ROUTING_MODE_LABEL, useRoutingMode } from "@/features/accounts/use-routing-mode";
import { useMediaQuery } from "@/hooks/use-media-query";
import { createApiKey, updateApiKey } from "@/lib/api/api-keys";
import { queryKeys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/api/server-errors";
import type { ApiKey, ApiKeyRoutingMode } from "@/lib/api/types";
import { type TFunction, useT } from "@/lib/i18n";
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

export type ApiKeyDialogTarget = { mode: "create" } | { mode: "edit"; apiKey: ApiKey };

/** The form's parts: the create dialog's tabs, the edit sheet's sections, in this order. */
type Section = "general" | "limits" | "accounts" | "routing";

const SECTIONS: readonly Section[] = ["general", "limits", "accounts", "routing"];

const SECTION_ICON: Readonly<Record<Section, IconSvgElement>> = {
  general: Key01Icon,
  limits: DashboardSpeed02Icon,
  accounts: UserMultipleIcon,
  routing: Route01Icon,
};

/** Where each field that can fail lives, so a failed submit opens its tab. */
const FIELD_SECTION: Readonly<Record<ApiKeyFormField, Section>> = {
  tokenLimit: "limits",
  creditLimit: "limits",
  callLimit: "limits",
  rpmLimit: "limits",
  accountIds: "accounts",
  allowedModels: "routing",
};

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

function sectionLabel(section: Section, t: TFunction): string {
  switch (section) {
    case "general":
      return t("form.tabGeneral");
    case "limits":
      return t("usage.limits");
    case "accounts":
      return t("form.accounts");
    case "routing":
      return t("form.tabRouting");
  }
}

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
 * failed check marks its one field, tells `reveal` which section holds it (the dialog opens that
 * tab), then focuses the field once it is on screen.
 */
function useKeyForm(
  target: ApiKeyDialogTarget,
  onOpenChange: (open: boolean) => void,
  onCreated: (key: string) => void,
  reveal?: (section: Section) => void,
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
  // Bumped on each failed submit, so the effect focuses the field after its tab is shown.
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
      reveal?.(FIELD_SECTION[parsed.field]);
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

/** Name, expiry and the custom key. */
function GeneralSection({ form }: { form: KeyForm }): JSX.Element {
  const { t } = useT("api");
  return (
    <>
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
    </>
  );
}

/** The four limits, two by two from sm up. */
function LimitsSection({ form }: { form: KeyForm }): JSX.Element {
  const { t } = useT("api");
  const limit = (
    field: ApiKeyLimitField,
    label: string,
    options: { max?: number; step?: number; format?: Intl.NumberFormatOptions } = {},
  ) => (
    <Field invalid={form.invalid === field}>
      <FieldLabel>{label}</FieldLabel>
      <NumberField
        format={options.format}
        max={options.max}
        min={0}
        onValueChange={(value) => form.set(field, value)}
        step={options.step ?? 1}
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
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {limit("tokenLimit", t("form.tokenLimit"))}
      {/* Two decimals, as formatCredits shows credits in the table and the cards. */}
      {limit("creditLimit", t("form.creditLimit"), { format: CREDIT_FORMAT, step: 0.01 })}
      {limit("callLimit", t("form.callLimit"))}
      {limit("rpmLimit", t("form.rpmLimit"), { max: MAX_KEY_RPM })}
      <FieldHint className="sm:col-span-2">{t("form.limitsHint")}</FieldHint>
    </div>
  );
}

/** Which accounts the key reaches. The tab or the section heading names it. */
function AccountsSection({ form }: { form: KeyForm }): JSX.Element {
  return (
    <AccountPicker
      hideLegend
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

/** The routing mode, then the models the key may call. */
function RoutingSection({ form }: { form: KeyForm }): JSX.Element {
  const { t } = useT("api");
  const globalMode = useRoutingMode();
  const routingItems = KEY_ROUTING_MODES.map((mode) => ({
    value: mode,
    label:
      mode === "inherit"
        ? t("form.routingInherit", { mode: t(ROUTING_MODE_LABEL[globalMode]) })
        : t(ROUTING_MODE_LABEL[mode]),
  }));
  const modelsInvalid =
    form.invalid !== "allowedModels"
      ? undefined
      : form.modelsError === "noModels"
        ? t("form.modelsRequired")
        : form.modelsError === "tooManyModels"
          ? t("form.tooManyModels", { max: MAX_KEY_MODELS })
          : t("form.modelTooLong", { max: MAX_KEY_MODEL_LENGTH });
  return (
    <>
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
      <ModelPicker
        invalid={modelsInvalid}
        onScopeChange={(scope) => form.set("modelScope", scope)}
        onSelectedChange={(models) => form.set("allowedModels", models)}
        scope={form.values.modelScope}
        searchRef={form.refs.allowedModels}
        selected={form.values.allowedModels}
      />
    </>
  );
}

function SectionBody({ section, form }: { section: Section; form: KeyForm }): JSX.Element {
  switch (section) {
    case "general":
      return <GeneralSection form={form} />;
    case "limits":
      return <LimitsSection form={form} />;
    case "accounts":
      return <AccountsSection form={form} />;
    case "routing":
      return <RoutingSection form={form} />;
  }
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

/*
 * The body under the header: a hairline, then one fixed height from sm up (448 px), so the dialog
 * keeps its size from tab to tab; on phones it takes what the 90dvh dialog leaves.
 */
const CREATE_BODY = "min-h-0 flex-1 gap-0 border-border-subtle border-t sm:h-112 sm:flex-none";

/**
 * Create: a settings-style dialog. From sm up the sections are a vertical tab list on the left
 * and one section on the right; on phones the tabs run along the top of a full-height dialog. A tab whose section has the
 * failed field carries a red dot, and a failed submit opens it.
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
  const phone = useMediaQuery("max-sm");
  const [tab, setTab] = useState<Section>("general");
  const form = useKeyForm({ mode: "create" }, onOpenChange, onCreated, setTab);
  const failedSection = form.invalid ? FIELD_SECTION[form.invalid] : null;

  return (
    <ResponsiveDialog
      // On phones the dialog fills its 90dvh box, so switching tabs never resizes it.
      anchor={phone ? "top" : "center"}
      footer={<FormActions form={form} onCancel={() => onOpenChange(false)} />}
      initialFocus={form.refs.name}
      onOpenChange={onOpenChange}
      open={open}
      panel={false}
      size="2xl"
      title={t("form.createTitle")}
    >
      <Tabs
        className={CREATE_BODY}
        onValueChange={(value) => setTab(value as Section)}
        orientation={phone ? "horizontal" : "vertical"}
        value={tab}
      >
        <div className="min-w-0 shrink-0 max-sm:px-4 sm:w-48 sm:border-border-subtle sm:border-e sm:bg-surface-inset sm:p-2">
          <TabsList variant={phone ? "underline" : "nav"}>
            {SECTIONS.map((section) => (
              <TabsTab key={section} value={section}>
                <HugeiconsIcon
                  aria-hidden="true"
                  className="max-sm:hidden"
                  icon={SECTION_ICON[section]}
                />
                {sectionLabel(section, t)}
                {failedSection === section ? (
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full bg-destructive sm:ms-auto"
                    data-slot="tab-error-dot"
                  />
                ) : null}
              </TabsTab>
            ))}
          </TabsList>
        </div>
        <ScrollArea className="min-h-0 flex-1" overscrollContain scrollFade>
          <form
            aria-busy={form.pending || undefined}
            className="flex flex-col gap-4 p-4"
            id={form.formId}
            noValidate
            onSubmit={form.onSubmit}
          >
            {SECTIONS.map((section) => (
              <TabsPanel className="flex flex-col gap-4" keepMounted key={section} value={section}>
                <SectionBody form={form} section={section} />
              </TabsPanel>
            ))}
            <ServerError form={form} />
          </form>
        </ScrollArea>
      </Tabs>
    </ResponsiveDialog>
  );
}

/**
 * Edit: the right-hand sheet (a bottom sheet below md), every section one under another under its
 * heading, with the actions in the sheet's foot.
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
  const headingId = useId();

  return (
    <ResponsiveSheet onOpenChange={onOpenChange} open={open}>
      <ResponsiveSheetHeader>
        <ResponsiveSheetTitle>{t("form.editTitle")}</ResponsiveSheetTitle>
        {apiKey.keyMasked ? (
          <ResponsiveSheetDescription className="truncate font-mono">
            {apiKey.keyMasked}
          </ResponsiveSheetDescription>
        ) : null}
      </ResponsiveSheetHeader>
      <ResponsiveSheetPanel>
        <form
          aria-busy={form.pending || undefined}
          className="flex flex-col gap-6"
          id={form.formId}
          noValidate
          onSubmit={form.onSubmit}
        >
          {SECTIONS.map((section) => (
            <section
              aria-labelledby={`${headingId}-${section}`}
              className="flex flex-col gap-4 border-border-subtle border-t pt-6 first:border-t-0 first:pt-0"
              key={section}
            >
              <h3 className="font-semibold text-heading" id={`${headingId}-${section}`}>
                {sectionLabel(section, t)}
              </h3>
              <SectionBody form={form} section={section} />
            </section>
          ))}
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
 * Create opens the tabbed dialog, edit the sheet. The parent remounts it for every opening, so
 * each one starts from fresh values. Server errors (duplicate key, collision, limits) show
 * inside it.
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
