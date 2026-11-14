import { Fragment, type JSX, type ReactNode } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { OpenLinkButton } from "@/components/shared/open-link-button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { useT } from "@/lib/i18n";
import { cn, keyByText } from "@/lib/utils";

/**
 * The value with a break opportunity after each "/", so a long URL wraps at its path segments.
 * Chrome does not break after "/" under wrap-anywhere, so it would split a word instead
 * ("/v1/chat/comp|letions"). The <wbr> adds no text: copying and selection keep the raw value.
 */
function breakAtSlashes(value: string): ReactNode {
  const parts = value.split("/");
  if (parts.length === 1) return value;
  return keyByText(parts, (part) => part).map(({ key, item: part }, index) => (
    <Fragment key={key}>
      {part}
      {index < parts.length - 1 ? (
        <>
          /<wbr />
        </>
      ) : null}
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
const MULTILINE_GROUP = "min-h-9 pointer-coarse:min-h-10";
const MULTILINE_TEXT =
  "block min-w-0 flex-1 cursor-text select-all whitespace-normal py-1 ps-3 font-mono text-foreground text-meta leading-5 outline-none";

/**
 * A value to copy (a URL, a key, a command) in a read-only field: mono text in the soft field,
 * with a copy button and, for a link, an open button at its end. One line scrolls inside the
 * input (focus selects it all); `multiline` wraps the value instead: a command (a value with
 * spaces) only between its words, a URL at its slashes (then anywhere), anything else (a key, a
 * token) at any character, so it fills every line evenly instead of leaving "sk-" alone on the
 * first one.
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
  openHref,
  openLabel,
  actions,
  id,
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
  /** Adds an open button that opens this address in a new tab. */
  openHref?: string;
  /** The open button's name, required with `openHref` (without it no open button shows). */
  openLabel?: string;
  /** More icon buttons in the field, before Copy (the metrics token's New token). */
  actions?: ReactNode;
  id?: string;
  /** On the group: layout only. */
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const shown = display ?? value;
  const words = multiline && shown.includes(" ");
  return (
    <InputGroup className={cn(multiline && MULTILINE_GROUP, className)} data-slot="copy-field">
      {multiline ? (
        <InputGroupText
          aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelledBy}
          aria-multiline="true"
          aria-readonly="true"
          className={cn(
            MULTILINE_TEXT,
            words ? "overflow-x-auto" : shown.includes("/") ? "wrap-anywhere" : "break-all",
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
      <InputGroupAddon align="inline-end" className="gap-0.5">
        {openHref && openLabel ? (
          <OpenLinkButton href={openHref} label={openLabel} size="icon-sm" variant="quiet" />
        ) : null}
        {actions}
        <CopyButton
          copiedMessage={copiedMessage}
          label={copyLabel ?? t("actions.copy")}
          size="icon-sm"
          value={value}
          variant="quiet"
        />
      </InputGroupAddon>
    </InputGroup>
  );
}
