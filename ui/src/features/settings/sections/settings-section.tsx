import { type UseQueryResult, useMutation } from "@tanstack/react-query";
import { EyeIcon, EyeOffIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
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
import { CardSkeleton } from "@/components/shared/loading-state";
import { SectionCard } from "@/components/shared/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api/server-errors";
import { type TFunction, useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useReportDirty } from "../lib/unsaved";

/** The id of the settings card a control sits in, so Save can report its card as dirty. */
const SectionIdContext = createContext<string | undefined>(undefined);

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
            className="h-auto px-0 align-baseline text-muted-foreground text-sm underline underline-offset-4 hover:text-foreground"
            size="xs"
            variant="link"
          />
        }
      >
        <InfoIcon aria-hidden="true" />
        {t("learnMore")}
      </PopoverTrigger>
      <PopoverPopup className="max-w-xs text-sm">{children}</PopoverPopup>
    </Popover>
  );
}

export function DefaultTag({ on }: { on: boolean }): JSX.Element {
  const { t } = useT("settings");
  return (
    <Badge className="font-normal text-muted-foreground" variant="outline">
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
      className="aria-disabled:pointer-events-none aria-disabled:opacity-64 aria-disabled:shadow-none aria-disabled:inset-shadow-none"
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
 * A settings card in its own form: Enter in a field submits it, and Save is the submit button.
 * `hint` is at most two sentences; `learnMore` holds the rest behind a popover.
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
        <SectionCard
          actions={headerActions}
          className="scroll-mt-16"
          description={description}
          footer={footer}
          id={id}
          title={title}
        >
          {children}
        </SectionCard>
      </form>
    </SectionIdContext.Provider>
  );
}

/**
 * Skeleton while the card's query loads, an error card with Retry when it fails. A card built on
 * the shared GET /settings query (`shared`) shows no error of its own: the page shows one for
 * all of them, and the card leaves only a hidden anchor (the nav then goes to the page error).
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
      <div className="scroll-mt-16" id={id}>
        <CardSkeleton lines={3} />
      </div>
    );
  }
  if (query.isError && shared) {
    return <div hidden id={id} />;
  }
  if (query.isError) {
    return (
      <SectionCard className="scroll-mt-16" id={id} title={title}>
        <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
      </SectionCard>
    );
  }
  return <>{children(query.data)}</>;
}

/** A switch with its label and an optional hint under the label. */
export function SwitchField({
  checked,
  onCheckedChange,
  label,
  hint,
  extra,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  /** Next to the label, for a "Default: on" tag. */
  extra?: ReactNode;
  className?: string;
}): JSX.Element {
  const id = useId();
  // The label row is at least 40 px tall, so the label is a full-size touch target for the
  // switch. The hint sits under the label, in the second column.
  return (
    <div className={cn("grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3", className)}>
      <Switch
        aria-describedby={hint ? `${id}-hint` : undefined}
        aria-labelledby={`${id}-label`}
        checked={checked}
        id={id}
        onCheckedChange={(next) => onCheckedChange(next)}
      />
      <div className="flex min-h-10 min-w-0 flex-wrap items-center gap-x-2">
        <Label className="min-h-10 cursor-pointer" htmlFor={id} id={`${id}-label`}>
          {label}
        </Label>
        {extra}
      </div>
      {hint ? (
        <p className="col-start-2 -mt-1.5 text-muted-foreground text-xs" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
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
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">
      {children}
    </code>
  );
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
          variant="ghost"
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
