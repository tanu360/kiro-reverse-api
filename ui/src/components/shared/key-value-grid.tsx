import type { JSX, ReactNode } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { TruncatedText } from "@/components/shared/truncated-text";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/*
 * Columns follow the grid's own width (container queries), not the viewport, so every grid in
 * one sheet or card switches at the same width: 1 column under 20rem, 2 from @xs (a phone sheet's
 * 358 px content still pairs Input with Output), 3 from @2xl.
 */
const COLUMN_CLASS = {
  1: "grid-cols-1",
  2: "grid-cols-1 @xs:grid-cols-2",
  3: "grid-cols-1 @xs:grid-cols-2 @2xl:grid-cols-3",
} as const;

export interface KeyValueItem {
  label: string;
  value: ReactNode;
  /** Spans two columns once the grid has two. */
  span?: 1 | 2;
  /** An ID, key or URL: mono 13 px on one line, cut with an ellipsis (full text as a tooltip). */
  mono?: boolean;
  /**
   * A copy button right after the value. `true` copies the value itself (a string or number);
   * a string copies that text instead (e.g. the unmasked ID behind a masked one).
   */
  copy?: boolean | string;
}

function copyText(item: KeyValueItem): string | null {
  if (typeof item.copy === "string") return item.copy;
  if (item.copy && (typeof item.value === "string" || typeof item.value === "number")) {
    return String(item.value);
  }
  return null;
}

function Value({ item }: { item: KeyValueItem }): ReactNode {
  if (!item.mono) return item.value;
  if (typeof item.value === "string") {
    return <TruncatedText className="font-mono text-meta">{item.value}</TruncatedText>;
  }
  return <span className="block min-w-0 truncate font-mono text-meta">{item.value}</span>;
}

export function KeyValueGrid({
  items,
  columns = 2,
}: {
  items: KeyValueItem[];
  columns?: 1 | 2 | 3;
}): JSX.Element {
  const { t } = useT();
  return (
    <div className="@container min-w-0">
      <dl className={cn("grid gap-x-6 gap-y-3 text-sm", COLUMN_CLASS[columns])}>
        {items.map((item) => {
          const copy = copyText(item);
          return (
            <div
              className={cn(
                "flex min-w-0 flex-col gap-1",
                item.span === 2 && columns > 1 && "@xs:col-span-2",
              )}
              key={item.label}
            >
              <dt className="text-meta text-muted-foreground">{item.label}</dt>
              <dd
                className={cn(
                  "min-w-0 tabular-nums wrap-anywhere",
                  copy !== null && "flex items-center gap-1",
                )}
              >
                <Value item={item} />
                {copy !== null ? (
                  <CopyButton
                    className="shrink-0"
                    label={t("actions.copyValue", { label: item.label })}
                    size="icon-xs"
                    value={copy}
                  />
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
