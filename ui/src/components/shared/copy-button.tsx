import { AlertCircleIcon, CheckIcon, Copy01Icon } from "@hugeicons/core-free-icons";
import { type JSX, useEffect, useRef, useState } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { announce } from "@/lib/announce";
import { copyText } from "@/lib/clipboard";
import { copiedToastWanted } from "@/lib/copy-toast";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const COPIED_MS = 2000;

/**
 * Copies a value and says so on the button itself, with no toast: a tick in place of the copy
 * icon and "Copied" as its tooltip for two seconds; a failed copy shows the alert icon and the
 * reason the same way. A screen reader hears it too, except on a phone, where the OS says it
 * (Android shows its own "Copied").
 * Icon-only by default, with `label` as its accessible name and tooltip; the touch sizes come
 * from the Button's icon sizes. `showLabel` makes it a small outline button with the label.
 */
export function CopyButton({
  value,
  label,
  variant,
  size = "icon",
  showLabel = false,
  copiedMessage,
  className,
}: {
  value: string | (() => Promise<string>);
  label: string;
  /** What a screen reader hears; defaults to "Copied to the clipboard." */
  copiedMessage?: string;
  /** Ghost by default when icon-only, secondary (soft fill) with a label. */
  variant?: "ghost" | "quiet" | "outline" | "secondary";
  /** The icon size; a labelled button is always `sm` (the value "sm" is kept for old callers). */
  size?: "icon" | "icon-sm" | "icon-xs" | "sm";
  showLabel?: boolean;
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  const copied = result === "copied";
  const failed = result === "failed";
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onClick = async () => {
    // A lazy value is passed on as a promise so Safari keeps the user activation for the write.
    const ok = await copyText(typeof value === "function" ? value() : value);
    if (!ok) announce(t("toast.copyFailed"), { assertive: true });
    else if (copiedToastWanted({ marksItself: true })) {
      announce(copiedMessage ?? t("toast.copiedToClipboard"));
    }
    setResult(ok ? "copied" : "failed");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setResult(null);
      timerRef.current = null;
    }, COPIED_MS);
  };

  const iconOnly = !showLabel;
  const Icon = copied ? CheckIcon : failed ? AlertCircleIcon : Copy01Icon;
  const said = copied ? t("toast.copied") : failed ? t("toast.copyFailed") : label;
  const button = (
    <Button
      aria-label={iconOnly ? label : undefined}
      className={className}
      data-copied={copied ? "" : undefined}
      data-copy-failed={failed ? "" : undefined}
      onClick={onClick}
      size={iconOnly ? (size === "sm" ? "icon" : size) : "sm"}
      variant={variant ?? (iconOnly ? "ghost" : "secondary")}
    >
      <AnimatedIcon
        icon={Icon}
        aria-hidden="true"
        className={cn(copied && "text-success-foreground", failed && "text-destructive-foreground")}
        // The tick plays when it lands; the copy icon coming back two seconds later stays still.
        playOnSwap={copied || failed}
      />
      {iconOnly ? null : <span>{said}</span>}
    </Button>
  );

  if (!iconOnly) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{said}</TooltipPopup>
    </Tooltip>
  );
}
