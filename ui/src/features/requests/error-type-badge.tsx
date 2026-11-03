import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";
import { type ErrorTone, errorTypeTone, isKnownErrorType } from "./request-model";

const TONE_VARIANT = {
  muted: "secondary",
  warning: "warning",
  destructive: "error",
} as const satisfies Record<ErrorTone, string>;

/** Error category pill: muted, warning or destructive, like the old UI's three tiers. */
export function ErrorTypeBadge({ type }: { type?: string }): JSX.Element | null {
  const { t } = useT("requests");
  if (!type) return null;
  const label = isKnownErrorType(type) ? t(`errorType.${type}`) : type;
  return (
    <Badge data-tone={errorTypeTone(type)} variant={TONE_VARIANT[errorTypeTone(type)]}>
      {label}
    </Badge>
  );
}
