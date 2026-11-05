import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Inline code in running text: a model id, a path, a header or a host, on the see-through
 * inline-code chip (index.css). Kept on one line: a name broken at its hyphens reads as two.
 */
export function Code({
  children,
  className,
}: {
  children: ReactNode;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  return <code className={cn("inline-code whitespace-nowrap", className)}>{children}</code>;
}
