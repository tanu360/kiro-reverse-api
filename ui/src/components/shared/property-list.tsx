import { Cancel01Icon, PencilEdit01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { SETTINGS_ROW_X } from "@/components/shared/settings-rows";
import { TruncatedText } from "@/components/shared/truncated-text";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { EMPTY } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A detail sheet's facts as flush rows in a slim card: the label muted at the start, the value
 * at the end, a hairline between rows. Unlike KeyValueGrid's label-over-value cells, a row keeps
 * one line at every width, so a phone sheet stays as short as a desktop one.
 */
export function PropertyList({
  className,
  children,
}: {
  className?: string;
  /** PropertyRow elements (or components that render one). */
  children: ReactNode;
}): JSX.Element {
  return (
    <dl className={cn("min-w-0 divide-y divide-border-subtle text-sm", className)}>{children}</dl>
  );
}

export interface PropertyRowProps {
  label: string;
  /** The label's id, for a control that names itself after the row (an Edit button). */
  labelId?: string;
  /** A string or number; empty shows a dash. A node is shown as given. */
  value: ReactNode;
  /** An ID, key or URL: mono 12 px, cut with an ellipsis (the full text as a tooltip). */
  mono?: boolean;
  /**
   * A copy button after the value. `true` copies the value itself (a string or number); a
   * string copies that text instead.
   */
  copy?: boolean | string;
  /** A trailing control (an Edit button), after the value and any copy button. */
  action?: ReactNode;
}

function copyText(value: ReactNode, copy: boolean | string | undefined): string | null {
  if (typeof copy === "string") return copy;
  if (copy && (typeof value === "string" || typeof value === "number") && value !== "") {
    return String(value);
  }
  return null;
}

function Value({ value, mono }: { value: ReactNode; mono: boolean }): ReactNode {
  if (value === "" || value === EMPTY || value === null || value === undefined) {
    return <span className="text-muted-foreground">{EMPTY}</span>;
  }
  if (typeof value === "string" || typeof value === "number") {
    return (
      <TruncatedText className={cn("tabular-nums", mono && "font-mono text-meta")}>
        {String(value)}
      </TruncatedText>
    );
  }
  return <span className="min-w-0 truncate tabular-nums">{value}</span>;
}

/**
 * One row: 48 px tall whether or not it holds a control, so plain and editable rows keep one
 * rhythm. The label may wrap (a long translation); the value takes the rest and truncates.
 */
export function PropertyRow({
  label,
  labelId,
  value,
  mono = false,
  copy,
  action,
}: PropertyRowProps): JSX.Element {
  const { t } = useT();
  const copyValue = copyText(value, copy);
  return (
    <div className={cn(SETTINGS_ROW_X, "flex min-h-12 items-center gap-4 py-2")}>
      <dt className="max-w-1/2 shrink-0 text-muted-foreground" id={labelId}>
        {label}
      </dt>
      <dd className="flex min-w-0 flex-1 items-center justify-end gap-1 text-end">
        <Value mono={mono} value={value} />
        {copyValue !== null ? (
          <CopyButton
            className="shrink-0"
            label={t("actions.copyValue", { label })}
            size="icon-xs"
            value={copyValue}
          />
        ) : null}
        {action ? <span className="-me-1.5 ms-1 flex shrink-0">{action}</span> : null}
      </dd>
    </div>
  );
}

/**
 * A card's editable fields as InlineEditRow elements. The rows sit 8 px (12 px from sm) inside
 * the card, so a row's hover fill clears the card's edge while its text keeps the card's 16 px
 * (24 px) inset.
 */
export function InlineEditList({
  className,
  children,
}: {
  className?: string;
  /** InlineEditRow elements (or components that render one). */
  children: ReactNode;
}): JSX.Element {
  return (
    <dl className={cn("flex min-w-0 flex-col px-2 py-1.5 text-sm sm:px-3", className)}>
      {children}
    </dl>
  );
}

/*
 * From sm up a 8.5rem label column, then the value right after it, never at the card's far end.
 * On phones the label sits over the value (12 px, as in KeyValueGrid), so an ID or URL gets the
 * row's whole width instead of what a label column would leave.
 */
const ROW_GRID =
  "grid grid-cols-1 gap-x-4 rounded-lg px-2 sm:grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] sm:px-3";
const ROW_LABEL = "text-muted-foreground max-sm:text-meta";

export interface InlineEditRowProps {
  label: string;
  /** The saved value. A string or number; empty shows `placeholder` (or a dash). */
  value: ReactNode;
  /** Shown muted when the value is empty: what an empty field means ("Global proxy"). */
  placeholder?: string;
  /** An ID or a URL: mono, at the body size of the values around it. */
  mono?: boolean;
  /** Free text (notes): the read view keeps its line breaks and shows up to six lines. */
  multiline?: boolean;
  /**
   * The edit view gives the controls the whole row: the label above them at every width, and
   * Save and Cancel under them on phones. For a value longer than the space beside the label
   * (a machine ID), so it stays on one line.
   */
  wide?: boolean;
  /** Edit view (the controls) or read view (the value). */
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  /** Called on Save, or Enter in a field, while no save is running. */
  onSubmit: () => void;
  saving: boolean;
  /** The edit view's controls (a Field with its own hint and error). */
  children: ReactNode;
}

/**
 * One field that is read and edited in the same place (Atlassian's inline edit, Linear's
 * properties). Read view: the label, the value right after it, and a pencil that shows on hover;
 * the whole row is the Edit button. Edit view: the controls take the value's place, with Save and
 * Cancel at the row's end where the pencil was; Enter saves and Escape cancels without closing
 * the sheet around it. Focus moves into the first field, caret at the end, and back to the row
 * once the edit closes.
 */
export function InlineEditRow({
  label,
  value,
  placeholder,
  mono = false,
  multiline = false,
  wide = false,
  editing,
  onEdit,
  onCancel,
  onSubmit,
  saving,
  children,
}: InlineEditRowProps): JSX.Element {
  const { t } = useT();
  const labelId = useId();
  const editId = useId();
  const formRef = useRef<HTMLFormElement | null>(null);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const wasEditing = useRef(editing);

  useEffect(() => {
    if (editing && !wasEditing.current) {
      const field = formRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        "input:not([type=hidden]), textarea",
      );
      if (field) {
        field.focus();
        // Caret at the end, nothing selected: the value reads as text being edited, not as a
        // highlighted block, and typing adds to it rather than replacing it.
        const end = field.value.length;
        field.setSelectionRange(end, end);
      }
    } else if (!editing && wasEditing.current) {
      // The form is gone, so focus fell to the body: hand it back to the row. A click elsewhere
      // that ended the edit keeps its own focus.
      const active = document.activeElement;
      if (active === null || active === document.body) editRef.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  if (editing) {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      if (!saving) onSubmit();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
      // Escape ends the edit only; the sheet or dialog around the row stays open.
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    return (
      // No fill behind the edit view: the control takes the value's place in the same row
      // geometry, and its own border and focus ring mark the row being edited.
      <div
        className={cn(ROW_GRID, "items-start gap-y-1.5 py-1", wide && "sm:grid-cols-1")}
        data-slot="inline-edit-row"
        data-editing=""
      >
        {/* Beside the control, 8 px down from sm so it sits on the 36 px control's text line. */}
        <dt className={cn(ROW_LABEL, !wide && "sm:pt-2")} id={labelId}>
          {label}
        </dt>
        <dd className="min-w-0">
          <form
            className={cn("flex items-start gap-1", wide && "max-sm:flex-wrap")}
            noValidate
            onKeyDown={onKeyDown}
            onSubmit={submit}
            ref={formRef}
          >
            <div className={cn("min-w-0 flex-1", wide && "max-sm:basis-full")}>{children}</div>
            <div className={cn("flex shrink-0 gap-1", wide && "max-sm:ms-auto")}>
              <RowIconButton label={t("actions.save")} loading={saving} type="submit">
                <HugeiconsIcon icon={Tick02Icon} aria-hidden="true" />
              </RowIconButton>
              <RowIconButton label={t("actions.cancel")} onClick={onCancel}>
                <HugeiconsIcon icon={Cancel01Icon} aria-hidden="true" />
              </RowIconButton>
            </div>
          </form>
        </dd>
      </div>
    );
  }

  const empty = value === "" || value === null || value === undefined;
  return (
    <div
      className={cn(
        ROW_GRID,
        "group/row relative min-h-9 gap-y-0.5 transition-colors hover:bg-accent has-focus-visible:bg-accent max-sm:py-2 sm:pointer-coarse:min-h-10",
        multiline ? "items-start sm:py-2" : "items-center",
      )}
      data-slot="inline-edit-row"
    >
      <dt className={ROW_LABEL} id={labelId}>
        {label}
      </dt>
      <dd className={cn("flex min-w-0 gap-2", multiline ? "items-start" : "items-center")}>
        <span
          className={cn(
            "min-w-0 flex-1 tabular-nums",
            multiline ? "line-clamp-6 whitespace-pre-line break-words" : "truncate",
            empty ? "text-muted-foreground" : mono && "font-mono",
          )}
        >
          {empty ? (placeholder ?? EMPTY) : value}
        </span>
        {/* The row's one control, stretched over the whole row; the pencil is its visible part. */}
        <button
          aria-labelledby={`${editId} ${labelId}`}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground opacity-0 transition-opacity after:absolute after:inset-0 after:rounded-lg focus-visible:opacity-100 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset group-hover/row:opacity-100 pointer-coarse:opacity-100"
          onClick={onEdit}
          ref={editRef}
          type="button"
        >
          <HugeiconsIcon className="size-4" icon={PencilEdit01Icon} aria-hidden="true" />
          <span className="sr-only" id={editId}>
            {t("actions.edit")}
          </span>
        </button>
      </dd>
    </div>
  );
}

function RowIconButton({
  label,
  children,
  ...props
}: {
  label: string;
  children: ReactNode;
  loading?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button aria-label={label} size="icon" type="button" variant="quiet" {...props} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
