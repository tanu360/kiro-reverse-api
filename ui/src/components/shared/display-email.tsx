import type { JSX } from "react";
import { TruncatedText } from "@/components/shared/truncated-text";
import { useDisplayEmail } from "@/lib/privacy";

/**
 * An account's address on one line. A cut-off address shows in full in a tooltip: the real
 * address, or the masked one under privacy mode (the real address never reaches the tooltip
 * then).
 */
export function DisplayEmail({
  email,
  id,
  className,
}: {
  email?: string;
  id?: string;
  className?: string;
}): JSX.Element {
  const display = useDisplayEmail();
  return <TruncatedText className={className}>{display(email, id)}</TruncatedText>;
}
