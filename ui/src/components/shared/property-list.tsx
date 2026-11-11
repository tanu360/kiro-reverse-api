import type { JSX, ReactNode } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { SETTINGS_ROW_X } from "@/components/shared/settings-rows";
import { TruncatedText } from "@/components/shared/truncated-text";
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
