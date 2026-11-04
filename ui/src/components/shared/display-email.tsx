import type { JSX } from "react";
import { useDisplayEmail } from "@/lib/privacy";
import { cn } from "@/lib/utils";

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
  const text = display(email, id);
  // The title repeats the shown text, so a cut-off address can be read: the full address, or
  // the masked one under privacy mode (the real address never reaches the title then).
  return (
    <span className={cn("truncate", className)} title={email ? text : undefined}>
      {text}
    </span>
  );
}
