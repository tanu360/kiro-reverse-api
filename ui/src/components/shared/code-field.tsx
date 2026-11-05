import { ExternalLinkIcon } from "@hugeicons/core-free-icons";
import { Fragment, type JSX, type ReactNode } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { CopyButton } from "@/components/shared/copy-button";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";

/**
 * The value with a break opportunity after each "/", so a long URL wraps at its path segments.
 * Chrome does not break after "/" under wrap-anywhere, so it would split a word instead
 * ("/v1/chat/comp|letions"). The <wbr> adds no text: copying and selection keep the raw value.
 */
function breakAtSlashes(value: string): ReactNode {
  const parts = value.split("/");
  if (parts.length === 1) return value;
  return parts.map((part, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one string never reorder.
    <Fragment key={index}>
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
 * A value to copy (a URL, a key, a command) in a read-only field: mono text in the soft field,
 * with a copy button and, for a link, an open button at its end. One line scrolls inside the
 * input (focus selects it all); `multiline` wraps the value anywhere instead, for long URLs.
 * Inside a Base UI Field the input takes the field's label; otherwise pass `label`. The
 * multiline value is a read-only textbox (a tab stop), named by `label` or by `labelledBy`.
 */
export function CopyField({
  value,
  label,
  labelledBy,
  copyLabel,
  copiedMessage,
  multiline = false,
  openHref,
  openLabel,
  id,
  className,
}: {
  value: string;
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
  /** The open button's name, required with `openHref`. */
  openLabel?: string;
  id?: string;
  /** On the group: layout only. */
  className?: string;
}): JSX.Element {
  const { t } = useT();
  return (
    <InputGroup className={className} data-slot="copy-field">
      {multiline ? (
        <InputGroupText
          aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelledBy}
          aria-multiline="true"
          aria-readonly="true"
          className="block min-w-0 flex-1 cursor-text select-all whitespace-normal py-2 ps-3 font-mono text-foreground text-meta leading-normal outline-none wrap-anywhere"
          id={id}
          role="textbox"
          tabIndex={0}
        >
          {breakAtSlashes(value)}
        </InputGroupText>
      ) : (
        <InputGroupInput
          aria-label={label}
          className="font-mono sm:text-meta"
          id={id}
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          spellCheck={false}
          value={value}
        />
      )}
      <InputGroupAddon align="inline-end" className="gap-0.5">
        {openHref ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={openLabel}
                  render={<a href={openHref} rel="noopener noreferrer" target="_blank" />}
                  size="icon-sm"
                  variant="quiet"
                />
              }
            >
              <AnimatedIcon icon={ExternalLinkIcon} aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup>{openLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
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
