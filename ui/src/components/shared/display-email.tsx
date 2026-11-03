import type { JSX } from "react";
import { useDisplayEmail, usePrivacy } from "@/lib/privacy";
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
  const { enabled } = usePrivacy();
  // The full address goes in the title only when privacy mode is off.
  return (
    <span className={cn("truncate", className)} title={!enabled && email ? email : undefined}>
      {display(email, id)}
    </span>
  );
}
