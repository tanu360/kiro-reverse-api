import { CheckIcon, FloppyDiskIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  cloneElement,
  isValidElement,
  type JSX,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  useId,
} from "react";
import { StatusDot } from "@/components/shared/status-dot";
import { Button } from "@/components/ui/button";
import { HeadingIdContext, useHeadingId } from "@/components/ui/heading-context";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The settings layout (t3code's settings rows): a row title is 14 px medium in the text colour,
 * its description 12 px muted, at most 42rem wide.
 */
export const ROW_DESCRIPTION = "max-w-2xl text-pretty text-muted-foreground text-xs leading-normal";

/** A row's inline padding (the card's), for a row element that is not a SettingsRow. */
export const SETTINGS_ROW_X = "min-w-0 px-4";

type ControlWidth = "field" | "number" | "actions" | "value" | "block" | "auto";

/*
 * The control sits beside the text once the row has room for both (the text column's 16rem, the
 * 2rem gap and the control), and takes the full row under the text before that. The breakpoints
 * are the row's own width, so a row in a narrow column wraps like a row on a phone.
 */
const CONTROL_WIDTH: Record<ControlWidth, string> = {
  field: "w-full @xl/settings-row:w-72",
  number: "w-full @md/settings-row:w-36",
  // Buttons (Edit and Remove): their own width beside the text, so a long title keeps the room
  // a 18rem field slot would leave empty; under the text on a narrow row, like a field.
  actions: "w-full @xl/settings-row:w-auto",
  // A value to copy (the public link): its own width beside the text, up to 28rem, then it
  // wraps inside; under the text on a narrow row.
  value: "w-full @xl/settings-row:w-auto @xl/settings-row:max-w-md",
  // Always under the text at the row's full width: a select whose options are too long to sit
  // beside the text in a narrow card (a dialog's).
  block: "w-full",
  // A switch or one button, centred on the title and description beside it, however many lines
  // they take.
  auto: "col-start-2 row-start-1 flex shrink-0 items-center justify-end self-center",
};

/*
 * Compact rows (a dialog or a sheet, about 450 px wide): 12 px above and below, a 24 px gap, and
 * the control beside the text as soon as both fit, under it before that. A field (14rem) keeps
 * the text 10rem, so it goes under on a phone. A number (11rem: "2,000,000" fits between the −
 * and + buttons) keeps the text 5rem, as its titles are short ("Requests per minute" takes two
 * lines), so it stays beside the text on a phone too, even in a sheet's card (a 283 px row).
 * The breakpoints are text + gap + control.
 */
const COMPACT_CONTROL_WIDTH: Partial<Record<ControlWidth, string>> = {
  field: "w-full @min-[25.5rem]/settings-row:w-56",
  number: "w-full @min-[17.5rem]/settings-row:w-44",
};

/** The compact text column's least width, by control (COMPACT_CONTROL_WIDTH). */
const COMPACT_TEXT_BASIS: Partial<Record<ControlWidth, string>> = {
  number: "basis-20",
};

/** A row title: a Label for the control when `htmlFor` is set, red in a danger row. */
export function SettingsRowTitle({
  htmlFor,
  id,
  tone = "default",
  children,
}: {
  htmlFor?: string;
  id?: string;
  tone?: "default" | "danger";
  children: ReactNode;
}): JSX.Element {
  const className = cn(
    "font-medium text-sm/5",
    tone === "danger" ? "text-destructive-foreground" : "text-foreground",
  );
  if (htmlFor) {
    return (
      <Label className={cn(className, "cursor-pointer")} htmlFor={htmlFor} id={id}>
        {children}
      </Label>
    );
  }
  return (
    <span className={className} id={id}>
      {children}
    </span>
  );
}

/** Joins id lists for aria-labelledby / aria-describedby, dropping empty ones. */
function joinIds(...ids: Array<string | undefined>): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined === "" ? undefined : joined;
}

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string; "aria-label"?: string };

/**
 * One settings row: the title (with an optional `status` after it) and its description on the
 * left, the control at the end. The title and description ids are put on the control as
 * aria-labelledby and aria-describedby, so a control without a visible label of its own is
 * named and described by the row. `children` go under the description (a current value, a
 * field's error). `notice` (a failed action with Try again) goes last, across the whole row under
 * the text and the control. `controlWidth` sizes the control slot: a text field or select
 * (`field`), a number field or a select of short options (`number`), a group of buttons at their
 * own width (`actions`), a value to copy at its own width (`value`), or the control's own width
 * (`auto`: a switch or a button, beside the text and centred on it at every width, while
 * `children` such as a warning notice take the row's full width under the description). A Button
 * control keeps its own name (its label, "Add rule"): the row title is not put on it, only the
 * description. `labelControl` overrides that either way.
 */
export function SettingsRow({
  title,
  description,
  htmlFor,
  status,
  tone = "default",
  control,
  controlWidth = "field",
  labelControl,
  compact = false,
  children,
  notice,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** The control's id: the title becomes its label (a click on it focuses or toggles it). */
  htmlFor?: string;
  /** After the title: a status dot, a badge or a count. */
  status?: ReactNode;
  tone?: "default" | "danger";
  control?: ReactNode;
  controlWidth?: ControlWidth;
  /**
   * Whether the row title names the control (aria-labelledby). On by default, off for a Button,
   * whose own label is its name.
   */
  labelControl?: boolean;
  /**
   * For rows in a dialog or a sheet: less padding, and a `field` or `number` control goes beside
   * the text from a narrower row up (COMPACT_CONTROL_WIDTH).
   */
  compact?: boolean;
  children?: ReactNode;
  /** A failed action of the row: last, at the row's full width (both columns). */
  notice?: ReactNode;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  const id = useId();
  const titleId = `${id}-title`;
  const hintId = description ? `${id}-hint` : undefined;
  let wired = control;
  if (isValidElement<AriaProps>(control)) {
    const own = control.props;
    const named = labelControl ?? control.type !== Button;
    wired = cloneElement(control as ReactElement<AriaProps>, {
      // A control with a name of its own keeps it; the row's title names the rest.
      "aria-labelledby":
        named && own["aria-label"] === undefined
          ? joinIds(own["aria-labelledby"], titleId)
          : own["aria-labelledby"],
      "aria-describedby": joinIds(own["aria-describedby"], hintId),
    });
  }
  const titleRow = (
    <div className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <SettingsRowTitle htmlFor={htmlFor} id={titleId} tone={tone}>
        {title}
      </SettingsRowTitle>
      {status}
    </div>
  );
  const hint = description ? (
    <p
      className={cn(ROW_DESCRIPTION, tone === "danger" && "text-destructive-foreground/80")}
      id={hintId}
    >
      {description}
    </p>
  ) : null;
  const width = (compact && COMPACT_CONTROL_WIDTH[controlWidth]) || CONTROL_WIDTH[controlWidth];
  const slot = wired ? <div className={width}>{wired}</div> : null;

  if (controlWidth === "auto") {
    // Two columns: the title and description beside the control, which sits centred on them;
    // `children` span both columns under them.
    return (
      <HeadingIdContext.Provider value={titleId}>
        <div
          className={cn(
            "@container/settings-row grid gap-x-8 py-4",
            slot ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1",
            SETTINGS_ROW_X,
            className,
          )}
          data-slot="settings-row"
        >
          <div className="flex min-w-0 flex-col gap-1">
            {titleRow}
            {hint}
          </div>
          {slot}
          {children ? (
            <div className="col-span-full flex min-w-0 flex-col gap-1 pt-1">{children}</div>
          ) : null}
          {notice ? (
            <div className="col-span-full flex min-w-0 flex-col gap-2 pt-2">{notice}</div>
          ) : null}
        </div>
      </HeadingIdContext.Provider>
    );
  }

  return (
    <HeadingIdContext.Provider value={titleId}>
      <div
        className={cn(
          "@container/settings-row flex flex-wrap items-center justify-between gap-y-3",
          compact ? "gap-x-6 py-3" : "gap-x-8 py-4",
          SETTINGS_ROW_X,
          className,
        )}
        data-slot="settings-row"
      >
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col gap-1",
            compact ? (COMPACT_TEXT_BASIS[controlWidth] ?? "basis-40") : "basis-64",
          )}
        >
          {titleRow}
          {hint}
          {children}
        </div>
        {slot}
        {/* A line of its own under the text and the control: the row's gap less 4 px, 8 px. */}
        {notice ? (
          <div className="-mt-1 flex min-w-0 basis-full flex-col gap-2">{notice}</div>
        ) : null}
      </div>
    </HeadingIdContext.Provider>
  );
}

/** The one line of a settings list with nothing in it ("No mappings yet."). */
export function SettingsEmptyRow({
  children,
  className,
}: {
  children: ReactNode;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  return (
    <p
      className={cn(SETTINGS_ROW_X, "py-4 text-start text-muted-foreground text-xs", className)}
      data-slot="settings-row"
    >
      {children}
    </p>
  );
}

/**
 * A switch as a settings row: the title (its label: a click on it toggles the switch) and the
 * description on the left, the switch at the end, centred on them at every width.
 */
export function SwitchField({
  checked,
  onCheckedChange,
  title,
  description,
  status,
  disabled,
  switchRef,
  children,
  notice,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  disabled?: boolean;
  switchRef?: Ref<HTMLElement>;
  children?: ReactNode;
  /** A failed action of the row: last, at the row's full width (SettingsRow `notice`). */
  notice?: ReactNode;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  const switchId = useId();
  return (
    <SettingsRow
      className={className}
      control={
        <Switch
          checked={checked}
          disabled={disabled}
          id={switchId}
          onCheckedChange={(next) => onCheckedChange(next)}
          ref={switchRef}
        />
      }
      controlWidth="auto"
      description={description}
      htmlFor={switchId}
      notice={notice}
      status={status}
      title={title}
    >
      {children}
    </SettingsRow>
  );
}

/**
 * A card's submit button, small with a leading icon (the floppy disk by default). While
 * `blocked` it is the quiet outline button and stays focusable (aria-disabled, not disabled), so
 * focus does not drop to the page when a save starts or the card turns clean; the click, and the
 * form's implicit Enter submission that clicks it, are cancelled instead. While `busy` the
 * Button's spinner stands in for the icon.
 */
export function SubmitButton({
  blocked,
  busy = false,
  primary,
  icon = FloppyDiskIcon,
  type = "submit",
  onClick,
  ref,
  className,
  children,
}: {
  blocked: boolean;
  busy?: boolean;
  /**
   * Whether it shows as the primary button; by default while it can submit. A button that stays
   * clickable to report a missing value passes false until there is one.
   */
  primary?: boolean;
  icon?: IconSvgElement | null;
  /** `button` for a save outside a form, with `onClick`. */
  type?: "submit" | "button";
  onClick?: () => void;
  ref?: Ref<HTMLButtonElement>;
  /** Layout only. */
  className?: string;
  children: ReactNode;
}): JSX.Element {
  // Every card has a Save: the card's title, read after it, says which one this is.
  const headingId = useHeadingId();
  return (
    <Button
      aria-busy={busy || undefined}
      aria-describedby={headingId}
      aria-disabled={blocked || busy || undefined}
      className={className}
      loading={busy}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (blocked || busy) {
          event.preventDefault();
          return;
        }
        onClick?.();
      }}
      ref={ref}
      size="sm"
      type={type}
      // Only a card with something to save shows the primary button; a clean one stays quiet.
      variant={(primary ?? (!blocked || busy)) ? "default" : "secondary"}
    >
      {icon ? <HugeiconsIcon icon={icon} aria-hidden="true" /> : null}
      {children}
    </Button>
  );
}

/**
 * Save: outline and inert while there is nothing to save, primary once there is. `saved` (a
 * useSavedFlash) reads "Saved" with a tick for a moment after a save.
 */
export function SaveButton({
  dirty,
  saving,
  saved = false,
  label,
  type,
  onClick,
  ref,
  className,
}: {
  dirty: boolean;
  saving: boolean;
  /** Just saved: "Saved" with a tick until the next change. */
  saved?: boolean;
  /** "Save" by default. */
  label?: string;
  type?: "submit" | "button";
  onClick?: () => void;
  ref?: Ref<HTMLButtonElement>;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const done = saved && !dirty && !saving;
  return (
    <SubmitButton
      blocked={!dirty || saving}
      busy={saving}
      // Full strength while it says so, though there is nothing to save.
      className={cn(done && "aria-disabled:not-aria-busy:opacity-100", className)}
      icon={done ? null : undefined}
      onClick={onClick}
      ref={ref}
      type={type}
    >
      {done ? (
        <>
          <HugeiconsIcon icon={CheckIcon} aria-hidden="true" className="text-success-foreground" />
          {t("actions.saved")}
        </>
      ) : saving ? (
        t("actions.saving")
      ) : (
        (label ?? t("actions.save"))
      )}
    </SubmitButton>
  );
}

/**
 * A card footer's content: the save state on the left ("Unsaved changes" with a warning dot
 * while dirty, or `status` in its place, such as a server-changed notice), `note` as a muted
 * line under it, and Save (or `action`) on the right.
 */
export function SaveFooter({
  dirty,
  saving = false,
  note,
  status,
  action,
  onSave,
  className,
}: {
  dirty: boolean;
  saving?: boolean;
  note?: ReactNode;
  status?: ReactNode;
  /** In place of the Save button. */
  action?: ReactNode;
  /** For a Save outside a form: Save becomes a plain button that calls this. */
  onSave?: () => void;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const state =
    status ??
    (dirty ? (
      <span className="inline-flex items-center gap-2 text-foreground">
        <StatusDot size="sm" tone="warning" />
        {t("form.unsaved")}
      </span>
    ) : null);
  return (
    <div
      className={cn(
        "flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2",
        className,
      )}
    >
      <div
        aria-live="polite"
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-meta text-muted-foreground"
      >
        {state}
        {note ? <span>{note}</span> : null}
      </div>
      {action ?? (
        <SaveButton
          dirty={dirty}
          onClick={onSave}
          saving={saving}
          type={onSave ? "button" : "submit"}
        />
      )}
    </div>
  );
}
