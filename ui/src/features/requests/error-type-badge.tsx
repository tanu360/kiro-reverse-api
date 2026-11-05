import { InfoIcon, OctagonXIcon, TriangleAlertIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { JSX } from "react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { type ErrorTone, errorTypeTone, isKnownErrorType } from "./request-model";

/** Line icons, so the category reads apart from the disc of the status pill beside it. */
const TONE_PILL = {
  muted: { tone: "neutral", icon: InfoIcon },
  warning: { tone: "warning", icon: TriangleAlertIcon },
  destructive: { tone: "destructive", icon: OctagonXIcon },
} as const satisfies Record<ErrorTone, { tone: BadgeTone; icon: IconSvgElement }>;

/** Error category pill: muted, warning or destructive, like the old UI's three tiers. */
export function ErrorTypeBadge({
  type,
  className,
}: {
  type?: string;
  className?: string;
}): JSX.Element | null {
  const { t } = useT("requests");
  if (!type) return null;
  const label = isKnownErrorType(type) ? t(`errorType.${type}`) : type;
  const tone = errorTypeTone(type);
  return (
    <Badge
      className={cn("min-w-0 justify-start", className)}
      data-tone={tone}
      icon={TONE_PILL[tone].icon}
      iconStyle="line"
      title={label}
      tone={TONE_PILL[tone].tone}
      variant="soft-outline"
    >
      {/* Truncates when a narrow column caps the pill's width (the title has the full text). */}
      <span className="truncate">{label}</span>
    </Badge>
  );
}
