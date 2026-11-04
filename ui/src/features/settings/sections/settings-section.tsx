import { type UseQueryResult, useMutation } from "@tanstack/react-query";
import {
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  ToggleLeftIcon,
  ToggleRightIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  createContext,
  type FormEvent,
  Fragment,
  type JSX,
  type MouseEvent,
  type ReactNode,
  useContext,
  useId,
  useState,
} from "react";
import { ErrorState } from "@/components/shared/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api/server-errors";
import { type TFunction, useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useReportDirty } from "../lib/unsaved";

/** The id of the settings card a control sits in, so Save can report its card as dirty. */
const SectionIdContext = createContext<string | undefined>(undefined);

/**
 * t3code's settings type (settingsLayout.tsx): a row title is 14 px medium in the text colour,
 * its description 12 px in the muted colour, at most 42rem wide.
 */
export const ROW_DESCRIPTION =
  "max-w-2xl text-balance text-muted-foreground text-xs leading-normal";

/** On a touch screen, an input grows to the 40 px touch-target height (36 px + borders). */
export const TOUCH_INPUT =
  "pointer-coarse:*:data-[slot=input]:h-9.5 pointer-coarse:*:data-[slot=input]:leading-9.5";

/** "Could not save settings: {reason}"; error toasts stay until dismissed. */
export function toastSaveFailed(error: unknown, t: TFunction): string {
  return toast.error(t("settings:saveFailed", { reason: errorMessage(error, t) }));
}

/**
 * One card's save: success toasts "Settings saved" and calls `onSaved`; failure toasts the
 * reason and calls `onFailed`. The API client throws on any non-2xx, so `res.ok` is checked.
 */
export function useSectionSave<V>(
  save: (variables: V) => Promise<unknown>,
  handlers: {
    onSaved: (variables: V) => void;
    onFailed?: (error: unknown, variables: V) => void;
    successMessage?: string;
  },
): { save: (variables: V) => void; saving: boolean } {
  const { t } = useT("settings");
  const mutation = useMutation({
    mutationFn: save,
    onSuccess: (_data, variables) => {
      handlers.onSaved(variables);
      toast.success(handlers.successMessage ?? t("saved"));
    },
    onError: (error, variables) => {
      handlers.onFailed?.(error, variables);
      toastSaveFailed(error, t);
    },
  });
  return { save: mutation.mutate, saving: mutation.isPending };
}

export function LearnMore({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useT("settings");
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            // Baseline-aligned on its text, not on the icon (a flex box takes its baseline from
            // its first baseline item), so the link does not push its line taller than the rest.
            className="h-auto items-baseline px-0 align-baseline text-muted-foreground text-xs underline underline-offset-4 hover:text-foreground [&_svg]:size-3 [&_svg]:self-center"
            size="xs"
            variant="link"
          />
        }
      >
        <InfoIcon aria-hidden="true" />
        {t("learnMore")}
      </PopoverTrigger>
      <PopoverPopup className="max-w-xs">{children}</PopoverPopup>
    </Popover>
  );
}

export function DefaultTag({ on }: { on: boolean }): JSX.Element {
  const { t } = useT("settings");
  return (
    <Badge icon={on ? ToggleRightIcon : ToggleLeftIcon} iconStyle="line" tone="neutral">
      {on ? t("defaultOn") : t("defaultOff")}
    </Badge>
  );
}

/** The card's footer: a server-change notice (or a note) beside the Save button. */
export function SaveFooter({
  dirty,
  saving,
  serverChanged,
  onReload,
  note,
}: {
  dirty: boolean;
  saving: boolean;
  serverChanged: boolean;
  onReload: () => void;
  note?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1 text-muted-foreground text-xs">
        {serverChanged ? <ServerChangedNotice onReload={onReload} /> : note}
      </div>
      <SaveButton dirty={dirty} saving={saving} />
    </div>
  );
}

/**
 * A card's submit button. While `blocked` it stays focusable (aria-disabled, not disabled), so
 * focus does not drop to the page when a save starts or the card turns clean; the click, and
 * the form's implicit Enter submission that clicks it, are cancelled instead.
 */
export function SubmitButton({
  blocked,
  busy = false,
  children,
}: {
  blocked: boolean;
  busy?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <Button
      aria-busy={busy || undefined}
      aria-disabled={blocked || undefined}
      className="aria-disabled:pointer-events-none"
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (blocked) event.preventDefault();
      }}
      type="submit"
    >
      {children}
    </Button>
  );
}

export function SaveButton({ dirty, saving }: { dirty: boolean; saving: boolean }): JSX.Element {
  const { t } = useT("settings");
  useReportDirty(useContext(SectionIdContext), dirty);
  return (
    <SubmitButton blocked={!dirty || saving} busy={saving}>
      {saving ? t("saving") : t("save")}
    </SubmitButton>
  );
}

export function ServerChangedNotice({ onReload }: { onReload: () => void }): JSX.Element {
  const { t } = useT("settings");
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" role="status">
      <TriangleAlertIcon aria-hidden="true" className="size-3.5 text-warning" />
      <span className="text-foreground">{t("serverChanged")}</span>
      <Button className="h-auto px-0 text-xs underline" onClick={onReload} size="xs" variant="link">
        {t("reload")}
      </Button>
    </span>
  );
}

/**
 * t3code's SettingsSection frame: the heading (16 px semibold, with the "Default" tag and any
 * actions at its end) sits above the group, outside it, and the group (the Card, t3code's
 * SettingsGroup) stacks its rows with the row divider (border at 50 %) between them.
 */
export function SettingsFrame({
  id,
  title,
  actions,
  className,
  children,
}: {
  id: string;
  title: string;
  actions?: ReactNode;
  /** On the group. */
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const headingId = `${id}-title`;
  return (
    <section aria-labelledby={headingId} className="flex scroll-mt-16 flex-col gap-2.5" id={id}>
      <div className="flex min-h-7 flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 sm:px-4">
        <h2
          className="flex min-h-7 items-center font-semibold text-foreground text-heading"
          id={headingId}
        >
          {title}
        </h2>
        {actions ? (
          <div className="flex min-h-7 flex-wrap items-center justify-end gap-2">{actions}</div>
        ) : null}
      </div>
      <Card
        className={cn("@container min-w-0 [&>*+*]:border-border/50 [&>*+*]:border-t", className)}
      >
        {children}
      </Card>
    </section>
  );
}

/** One row of a settings group: t3code's 12 px block and 12 px (16 px from sm) inline padding. */
export function SettingsRow({
  children,
  className,
  slot = "settings-row",
}: {
  children: ReactNode;
  className?: string;
  /** `card-footer` marks the row that holds Save. */
  slot?: "settings-row" | "card-footer";
}): JSX.Element {
  return (
    <div className={cn("min-w-0 px-3 py-3 sm:px-4", className)} data-slot={slot}>
      {children}
    </div>
  );
}

/**
 * A settings section in its own form: Enter in a field submits it, and Save is the submit button.
 * `hint` is at most two sentences; `learnMore` holds the rest behind a popover. The hint opens the
 * first row as t3code's row description; a section with one switch passes its hint to the
 * SwitchField instead, so the row reads title, description, control as in t3code. Save gets a row
 * of its own.
 */
export function SettingsSection({
  id,
  title,
  hint,
  learnMore,
  defaultOn,
  actions,
  footer,
  onSubmit,
  rows = false,
  children,
}: {
  id: string;
  title: string;
  hint?: ReactNode;
  learnMore?: ReactNode;
  /** Shows the "Default: on/off" tag. */
  defaultOn?: boolean;
  actions?: ReactNode;
  footer?: ReactNode;
  onSubmit?: () => void;
  /** The children are SettingsRows of their own, placed straight in the group (no hint row). */
  rows?: boolean;
  children: ReactNode;
}): JSX.Element {
  const description =
    hint || learnMore ? (
      <>
        {hint}
        {learnMore ? (
          <>
            {" "}
            <LearnMore>{learnMore}</LearnMore>
          </>
        ) : null}
      </>
    ) : undefined;
  const headerActions =
    defaultOn !== undefined || actions ? (
      <>
        {defaultOn !== undefined ? <DefaultTag on={defaultOn} /> : null}
        {actions}
      </>
    ) : undefined;

  return (
    <SectionIdContext.Provider value={id}>
      <form
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          onSubmit?.();
        }}
      >
        <SettingsFrame actions={headerActions} id={id} title={title}>
          {rows ? (
            children
          ) : (
            <SettingsRow className="flex flex-col gap-3">
              {description ? <p className={ROW_DESCRIPTION}>{description}</p> : null}
              {children}
            </SettingsRow>
          )}
          {footer ? (
            <SettingsRow className="flex items-center" slot="card-footer">
              {footer}
            </SettingsRow>
          ) : null}
        </SettingsFrame>
      </form>
    </SectionIdContext.Provider>
  );
}

/**
 * Skeleton while the section's query loads, an error group with Retry when it fails, both under
 * the section's heading. A section built on the shared GET /settings query (`shared`) shows no
 * error of its own: the page shows one for all of them, and the section leaves only a hidden
 * anchor (the nav then goes to the page error).
 */
export function SectionQuery<T>({
  id,
  title,
  query,
  shared = false,
  children,
}: {
  id: string;
  title: string;
  query: UseQueryResult<T>;
  shared?: boolean;
  children: (data: T) => ReactNode;
}): JSX.Element {
  if (query.isPending) {
    return (
      <SettingsFrame id={id} title={title}>
        <SettingsRow>
          <div aria-hidden="true" className="flex flex-col gap-2">
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="mt-1 h-6 w-2/5" />
          </div>
        </SettingsRow>
      </SettingsFrame>
    );
  }
  if (query.isError && shared) {
    return <div hidden id={id} />;
  }
  if (query.isError) {
    return (
      <SettingsFrame id={id} title={title}>
        <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
      </SettingsFrame>
    );
  }
  return <>{children(query.data)}</>;
}

/**
 * A switch as a t3code settings row: the label (the row title) and an optional hint (the row
 * description, with `learnMore` after it) on the left, the switch at the row's end. Below 32rem
 * of row width the switch keeps its place at the end; the text wraps beside it. On a touch
 * screen the label is at least 40 px tall, so it is a full-size touch target for the switch.
 */
export function SwitchField({
  checked,
  onCheckedChange,
  label,
  hint,
  learnMore,
  extra,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  learnMore?: ReactNode;
  /** Next to the label, for a "Default: on" tag. */
  extra?: ReactNode;
  className?: string;
}): JSX.Element {
  const id = useId();
  const described = hint || learnMore;
  return (
    <div className={cn("flex items-center justify-between gap-x-8", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2">
          <Label className="cursor-pointer pointer-coarse:min-h-10" htmlFor={id} id={`${id}-label`}>
            {label}
          </Label>
          {extra}
        </div>
        {described ? (
          <p className={ROW_DESCRIPTION} id={`${id}-hint`}>
            {hint}
            {learnMore ? (
              <>
                {" "}
                <LearnMore>{learnMore}</LearnMore>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
      <Switch
        aria-describedby={described ? `${id}-hint` : undefined}
        aria-labelledby={`${id}-label`}
        checked={checked}
        id={id}
        onCheckedChange={(next) => onCheckedChange(next)}
      />
    </div>
  );
}

/** Fills `{name}` placeholders of a translated template with React nodes (code spans). */
export function fillNodes(template: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return template.split(/(\{\w+\})/).map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    const node = name !== undefined && Object.hasOwn(nodes, name) ? nodes[name] : part;
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one template never reorder.
    return <Fragment key={index}>{node}</Fragment>;
  });
}

export function Code({ children }: { children: ReactNode }): JSX.Element {
  return <code className="inline-code text-foreground">{children}</code>;
}

/** A password input with a show/hide toggle. */
export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  placeholder,
  invalid,
  describedBy,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
}): JSX.Element {
  const { t } = useT("settings");
  const [visible, setVisible] = useState(false);
  const label = visible ? t("hidePassword") : t("showPassword");
  return (
    <InputGroup className={className}>
      <InputGroupInput
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        autoComplete={autoComplete}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        type={visible ? "text" : "password"}
        value={value}
      />
      <InputGroupAddon align="inline-end">
        <Button
          aria-label={label}
          aria-pressed={visible}
          onClick={() => setVisible((shown) => !shown)}
          size="icon-xs"
          title={label}
          variant="quiet"
        >
          {visible ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
        </Button>
      </InputGroupAddon>
    </InputGroup>
  );
}

/** A field error under a control, linked by `id` from the control's aria-describedby. */
export function FieldErrorText({ id, children }: { id: string; children: ReactNode }): JSX.Element {
  return (
    <p className="text-destructive-foreground text-xs" id={id} role="alert">
      {children}
    </p>
  );
}
