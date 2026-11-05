import { InfoIcon, OctagonXIcon, TriangleAlertIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { JSX } from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { type ErrorTone, errorTypeTone, isKnownErrorType } from "./request-model";

/*
 * Line icons in the tier's colour (the status ramps' disc step, >= 3:1), so the category reads
 * as a quiet label under or beside the one red "Failed" pill, not as a second pill.
 */
const TONE = {
  muted: { icon: InfoIcon, className: "text-muted-foreground" },
  warning: { icon: TriangleAlertIcon, className: "text-warning" },
  destructive: { icon: OctagonXIcon, className: "text-destructive" },
} as const satisfies Record<ErrorTone, { icon: IconSvgElement; className: string }>;

/** Error category: an icon in its tier's colour (muted, warning, destructive) and the label. */
export function ErrorTypeLabel({
  type,
  className,
}: {
  type?: string;
  /** Layout classes only (max-w-full). */
  className?: string;
}): JSX.Element | null {
  const { t } = useT("requests");
  if (!type) return null;
  const label = isKnownErrorType(type) ? t(`errorType.${type}`) : type;
  const tone = errorTypeTone(type);
  return (
    <span
      className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5", className)}
      data-slot="error-type"
      data-tone={tone}
    >
      <HugeiconsIcon
        aria-hidden="true"
        className={cn("size-3.5 shrink-0", TONE[tone].className)}
        icon={TONE[tone].icon}
      />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
