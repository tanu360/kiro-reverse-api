import { Fragment, type JSX, type ReactNode } from "react";
import { HighlightedCode } from "@/components/shared/code-block";
import { CopyButton } from "@/components/shared/copy-button";
import { OpenLinkButton } from "@/components/shared/open-link-button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import type { CodeLanguage } from "@/lib/highlight";
import { useT } from "@/lib/i18n";
import { cn, keyByText } from "@/lib/utils";

/** A host label or path segment up to this long never breaks at its hyphen. */
const NOWRAP_PIECE = 24;

/**
 * The value with a break opportunity after each "/" (not between the two of "https://") and each
 * ".", so a long URL wraps at its path segments and host labels. Chrome does not break after "/"
 * under wrap-anywhere, so it would split a word instead ("/v1/chat/comp|letions"). A piece with
 * a hyphen is one unbreakable run ("kiro-proxy.", not "kiro-|proxy."), unless it is longer than
 * NOWRAP_PIECE and could overflow a phone-wide field. The <wbr> adds no text: copying and
 * selection keep the raw value.
 */
function breakAtSlashes(value: string): ReactNode {
  const pieces = value.split(/(?<=\.)|(?<=\/)(?!\/)/);
  if (pieces.length === 1) return value;
  return keyByText(pieces, (piece) => piece).map(({ key, item: piece }, index) => (
    <Fragment key={key}>
      {piece.includes("-") && piece.length <= NOWRAP_PIECE ? (
        <span className="whitespace-nowrap">{piece}</span>
      ) : (
        piece
      )}
      {index < pieces.length - 1 ? <wbr /> : null}
    </Fragment>
  ));
}

/**
 * A command, a value with spaces: it breaks only between its words and, inside a path, after a
 * "/". Each piece is one unbreakable run, so no line ends mid-word ("--bu|ild") or at a hyphen;
 * a piece longer than the line scrolls sideways instead. Copying keeps the raw value.
 */
function breakAtWords(value: string): ReactNode {
  return keyByText(value.split(" "), (word) => word).map(({ key, item: word }, index) => {
    const segments = word.split("/");
    return (
      <Fragment key={key}>
        {index > 0 ? " " : null}
        {keyByText(segments, (segment) => segment).map(({ key: segmentKey, item }, at) => (
          <Fragment key={segmentKey}>
            <span className="whitespace-nowrap">
              {item}
              {at < segments.length - 1 ? "/" : null}
            </span>
            {at < segments.length - 1 ? <wbr /> : null}
          </Fragment>
        ))}
      </Fragment>
    );
  });
}

/*
 * The multiline value: a 20 px line with 4 px above and below, in a group that is at least a
 * field's height (36 / coarse 40, border included), so one line measures exactly like an
 * input beside it and the box grows only when the value wraps.
 */
const MULTILINE_GROUP = "min-h-8 sm:min-h-9 sm:pointer-coarse:min-h-10";
const MULTILINE_TEXT =
  "block min-w-0 flex-1 cursor-text select-all whitespace-normal ps-3 text-foreground text-meta leading-5 outline-none";

/*
 * The "outline" look (the public link): a hairline border with no fill, the value in the body
 * face, and each button in its own cell behind a divider. The cells stretch to the field's
 * height, so the dividers run edge to edge however many lines the value wraps to.
 */
const OUTLINE_GROUP = "items-stretch border-input bg-transparent hover:bg-transparent";
const OUTLINE_ADDON = "gap-0 self-stretch pe-0";
const OUTLINE_CELL = "flex items-center self-stretch border-input border-s px-0.5";

/*
 * The code look (a command to paste in a terminal): one highlighted line that never wraps and
 * scrolls sideways, fading at an edge it can still scroll past. A 20 px line with 7 px above and
 * below fills the 36 px field (40 on touch, centred); the copy button sits in its own cell behind
 * the field's hairline, so the text scrolls under the cell's edge and never under the button.
 */
const CODE_GROUP = "min-h-8 items-stretch sm:min-h-9 sm:pointer-coarse:min-h-10";
const CODE_TEXT =
  "scroll-fade-x block min-w-0 flex-1 cursor-text select-all self-center overflow-x-auto overscroll-x-contain text-clip whitespace-pre py-[7px] ps-3 pe-3 font-mono text-foreground text-meta leading-5 outline-none";
const CODE_CELL = "flex items-center self-stretch border-field-border border-s px-0.5";

/**
 * A value to copy (a URL, a key, a command) in a read-only field: mono text in the soft field,
 * with a copy button and, for a link, an open button at its end. One line scrolls inside the
 * input (focus selects it all); `multiline` wraps the value instead: a command (a value with
 * spaces) only between its words, a URL at its slashes (then anywhere), anything else (a key, a
 * token) at any character, so it fills every line evenly instead of leaving "sk-" alone on the
 * first one.
 * `language` shows a command as one highlighted line instead (CODE_TEXT).
 * Inside a Base UI Field the input takes the field's label; otherwise pass `label`. The
 * multiline value is a read-only textbox (a tab stop), named by `label` or by `labelledBy`.
 */
export function CopyField({
  value,
  display,
  label,
  labelledBy,
  copyLabel,
  copiedMessage,
  multiline = false,
  language,
  openHref,
  openLabel,
  actions,
  id,
  variant = "field",
  className,
}: {
  value: string;
  /** What the field shows when it differs from the value Copy copies (a masked token). */
  display?: string;
  /** The field's accessible name when no visible label points at it. */
  label?: string;
  /** The id of a visible label that names the multiline value (in place of `label`). */
  labelledBy?: string;
  /** The copy button's name; "Copy" by default. */
  copyLabel?: string;
  copiedMessage?: string;
  multiline?: boolean;
  /**
   * Shows the value as code in this language: one highlighted line that scrolls sideways, with
   * the copy button in its own cell (a command). Named by `label` or `labelledBy`.
   */
  language?: CodeLanguage;
  /** Adds an open button that opens this address in a new tab. */
  openHref?: string;
  /** The open button's name, required with `openHref` (without it no open button shows). */
  openLabel?: string;
  /** More icon buttons in the field, before Copy (the metrics token's New token). */
  actions?: ReactNode;
  id?: string;
  /** "outline": a bordered field with no fill and each button in its own cell. */
  variant?: "field" | "outline";
  /** On the group: layout only. */
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const shown = display ?? value;
  const words = multiline && shown.includes(" ");
  const outline = variant === "outline";
  const open =
    openHref && openLabel ? (
      <OpenLinkButton href={openHref} label={openLabel} size="icon-sm" variant="quiet" />
    ) : null;
  const copy = (
    <CopyButton
      copiedMessage={copiedMessage}
      label={copyLabel ?? t("actions.copy")}
      size="icon-sm"
      value={value}
      variant="quiet"
    />
  );
  if (language) {
    return (
      <InputGroup className={cn(CODE_GROUP, className)} data-slot="copy-field">
        <InputGroupText
          aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelledBy}
          aria-readonly="true"
          className={CODE_TEXT}
          id={id}
          role="textbox"
          tabIndex={0}
        >
          <HighlightedCode code={shown} language={language} />
        </InputGroupText>
        <InputGroupAddon align="inline-end" className={OUTLINE_ADDON}>
          {open ? <span className={CODE_CELL}>{open}</span> : null}
          {actions ? <span className={CODE_CELL}>{actions}</span> : null}
          <span className={CODE_CELL}>{copy}</span>
        </InputGroupAddon>
      </InputGroup>
    );
  }
  return (
    <InputGroup
      className={cn(multiline && MULTILINE_GROUP, outline && OUTLINE_GROUP, className)}
      data-slot="copy-field"
    >
      {multiline ? (
        <InputGroupText
          aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelledBy}
          aria-multiline="true"
          aria-readonly="true"
          className={cn(
            MULTILINE_TEXT,
            outline ? "py-[7px] pe-3" : "py-1 font-mono",
            // A wrapped URL balances its lines: "https://kiro-proxy." over "tail1234.ts.net",
            // not one line and a lone "net".
            words
              ? "overflow-x-auto"
              : shown.includes("/")
                ? "wrap-anywhere text-balance"
                : "break-all",
          )}
          id={id}
          role="textbox"
          tabIndex={0}
        >
          {words ? breakAtWords(shown) : breakAtSlashes(shown)}
        </InputGroupText>
      ) : (
        <InputGroupInput
          aria-label={label}
          className="font-mono sm:text-meta"
          id={id}
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          spellCheck={false}
          value={shown}
        />
      )}
      {outline ? (
        <InputGroupAddon align="inline-end" className={OUTLINE_ADDON}>
          {open ? <span className={OUTLINE_CELL}>{open}</span> : null}
          {actions ? <span className={OUTLINE_CELL}>{actions}</span> : null}
          <span className={OUTLINE_CELL}>{copy}</span>
        </InputGroupAddon>
      ) : (
        <InputGroupAddon align="inline-end" className="gap-0.5">
          {open}
          {actions}
          {copy}
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}
