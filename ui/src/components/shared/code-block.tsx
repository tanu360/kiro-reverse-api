import { type JSX, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { cn } from "@/lib/utils";

/** True while the element's content is wider than its box; rechecked on resize and new content. */
function useScrollsSideways(ref: RefObject<HTMLElement | null>, content: string): boolean {
  const [scrolls, setScrolls] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `content` changes the scroll width.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const check = () => setScrolls(element.scrollWidth > element.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, content]);
  return scrolls;
}

/**
 * A block of code (a config file, a command) with its title and a copy button in a strip above
 * it. The code is mono on the inset well and scrolls sideways inside the block, so long lines
 * never widen the page; while it scrolls, the block is a labelled tab stop so arrow keys can
 * scroll it. `wrap` wraps long lines instead (anywhere, keeping line breaks), for prose-like text
 * such as an error message.
 */
export function CodeBlock({
  code,
  title,
  copyLabel,
  copiedMessage,
  regionLabel,
  wrap = false,
  className,
}: {
  code: string;
  title: string;
  copyLabel: string;
  copiedMessage?: string;
  /** The scrolling region's name; the title by default. */
  regionLabel?: string;
  /** Wraps long lines (anywhere) instead of scrolling sideways. */
  wrap?: boolean;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  const preRef = useRef<HTMLPreElement>(null);
  const scrolls = useScrollsSideways(preRef, code);
  return (
    <figure
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface-inset",
        className,
      )}
      data-slot="code-block"
    >
      <div className="flex min-h-9 items-center justify-between gap-2 border-border-subtle border-b bg-surface-2 py-0.5 ps-3 pe-1">
        <figcaption className="min-w-0 truncate font-medium text-meta text-muted-foreground">
          {title}
        </figcaption>
        <CopyButton
          copiedMessage={copiedMessage}
          label={copyLabel}
          size="icon-sm"
          value={code}
          variant="quiet"
        />
      </div>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label is set only with role="region". */}
      <pre
        aria-label={scrolls ? (regionLabel ?? title) : undefined}
        className={cn(
          "scrollbar-x max-w-full overflow-x-auto p-3 font-mono text-foreground text-meta leading-relaxed outline-none focus-outline-inset",
          wrap && "whitespace-pre-wrap wrap-anywhere",
        )}
        data-wrap={wrap ? "" : undefined}
        ref={preRef}
        role={scrolls ? "region" : undefined}
        tabIndex={scrolls ? 0 : undefined}
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}
