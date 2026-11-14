import {
  Fragment,
  type JSX,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ThemedToken } from "shiki/core";
import { CopyButton } from "@/components/shared/copy-button";
import { type CodeLanguage, highlightCode } from "@/lib/highlight";
import { cn, keyByText } from "@/lib/utils";

function overflowsBox(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight;
}

/**
 * True while the element's content overflows its box (wider, or taller under `capHeight`);
 * rechecked on resize and new content.
 */
function useScrolls(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolls, setScrolls] = useState(false);
  // After every render, since new content (other code, its highlighted lines) changes the scroll
  // width. An unchanged result does not render again.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) setScrolls(overflowsBox(element));
  });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setScrolls(overflowsBox(element)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return scrolls;
}

/**
 * The code as highlighted lines once Shiki has them (lib/highlight.ts, loaded on first use), or
 * null while it loads, without a language, or if it fails: the block then shows the plain text.
 */
function useHighlightedLines(
  code: string,
  language: CodeLanguage | undefined,
): ThemedToken[][] | null {
  const [result, setResult] = useState<{
    code: string;
    language: CodeLanguage;
    lines: ThemedToken[][];
  } | null>(null);
  useEffect(() => {
    if (!language) return;
    let live = true;
    highlightCode(code, language).then(
      (lines) => {
        if (live) setResult({ code, language, lines });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [code, language]);
  return result && result.code === code && result.language === language ? result.lines : null;
}

/** Shiki's font style bit for italic (FontStyle.Italic). */
const ITALIC = 1;

function lineText(line: ThemedToken[]): string {
  return line.map((token) => token.content).join("");
}

/**
 * A block of code (a config file, a command) with its title and a copy button in a strip above
 * it. The code is mono on the inset well and scrolls sideways inside the block, so long lines
 * never widen the page; while it scrolls, the block is a named region. `wrap` wraps long lines
 * instead (anywhere, keeping line breaks), for prose-like text
 * such as an error message. `bare` drops the strip and the frame, for a panel that shows its own
 * title and copy button (the account tester's response).
 */
export function CodeBlock({
  code,
  title,
  copyLabel,
  copiedMessage,
  regionLabel,
  wrap = false,
  language,
  bare = false,
  actions,
  capHeight = false,
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
  /** Highlights the code as this language (the colours are the --code-token-* tokens). */
  language?: CodeLanguage;
  /** No title strip and no frame: the caller shows the title and the copy button. */
  bare?: boolean;
  /** Controls in the title strip, before the copy button (the request builder's client switch). */
  actions?: ReactNode;
  /** Caps the code at 288 px (13 lines); longer code scrolls inside the block instead of growing the page. */
  capHeight?: boolean;
  /** Layout only. */
  className?: string;
}): JSX.Element {
  const preRef = useRef<HTMLPreElement>(null);
  const scrolls = useScrolls(preRef);
  const lines = useHighlightedLines(code, language);
  const preClassName = cn(
    "max-w-full overflow-x-auto p-3 font-mono text-foreground text-meta leading-relaxed focus-outline-inset",
    wrap && "whitespace-pre-wrap wrap-anywhere",
    capHeight && "max-h-72 overflow-y-auto",
  );
  const content = (
    <code>
      {lines
        ? keyByText(lines, lineText).map(({ key, item: line }, index) => (
            <Fragment key={key}>
              {line.map((token) => (
                <span
                  key={token.offset}
                  style={{
                    color: token.color,
                    fontStyle:
                      token.fontStyle !== undefined && token.fontStyle & ITALIC
                        ? "italic"
                        : undefined,
                  }}
                >
                  {token.content}
                </span>
              ))}
              {index < lines.length - 1 ? "\n" : null}
            </Fragment>
          ))
        : code}
    </code>
  );
  return (
    <figure
      className={cn(
        "flex min-w-0 flex-col overflow-hidden bg-surface-inset",
        !bare && "rounded-lg border border-border",
        className,
      )}
      data-slot="code-block"
    >
      {bare ? (
        <figcaption className="sr-only">{title}</figcaption>
      ) : (
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-2 gap-y-0.5 border-border-subtle border-b bg-surface-2 py-0.5 ps-3 pe-1">
          <figcaption className="min-w-0 truncate font-medium text-meta text-muted-foreground">
            {title}
          </figcaption>
          {/* Actions wrap under the title on a strip too narrow for both. */}
          <div className="ms-auto flex min-w-0 items-center gap-2">
            {actions}
            <CopyButton
              copiedMessage={copiedMessage}
              label={copyLabel}
              size="icon-sm"
              value={code}
              variant="quiet"
            />
          </div>
        </div>
      )}
      {/*
        While the code scrolls (sideways, or down under capHeight), the section is named, which makes it a region landmark
        around the scroller (browsers make a scrolling box a tab stop themselves, so arrow keys
        scroll it); otherwise the unnamed section is plain markup. It stays mounted either way,
        so the measured <pre> is never replaced.
      */}
      <section aria-label={scrolls ? (regionLabel ?? title) : undefined} className="min-w-0">
        <pre className={preClassName} data-wrap={wrap ? "" : undefined} ref={preRef}>
          {content}
        </pre>
      </section>
    </figure>
  );
}
