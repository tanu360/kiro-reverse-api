import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * `inline` is the inline-code utility (index.css): 0.85 em of the running text, for prose.
 * `id` is the same chip at a fixed 12 px (font-mono text-meta), for keys and IDs in tables, cards
 * and sheets, so one ID reads at one size whatever the text around it.
 */
const VARIANT_CLASS = {
  inline: "inline-code",
  id: "rounded-sm bg-(--code-background) px-1 py-0.5 font-mono text-(--code-foreground) text-meta",
} as const;

/**
 * Inline code: a model id, a path, a header or a host, on the see-through inline-code chip.
 * Kept on one line: a name broken at its hyphens reads as two.
 */
export function Code({
  children,
  variant = "inline",
  className,
}: {
  children: ReactNode;
  /** `inline` in prose (sized by the text around it); `id` for a key or ID in a list (12 px). */
  variant?: "inline" | "id";
  /** Layout only. */
  className?: string;
}): JSX.Element {
  return (
    <code className={cn(VARIANT_CLASS[variant], "whitespace-nowrap", className)}>{children}</code>
  );
}
