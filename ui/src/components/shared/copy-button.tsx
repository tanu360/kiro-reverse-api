import { CheckIcon, Copy01Icon } from "@hugeicons/core-free-icons";
import { type JSX, useEffect, useRef, useState } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const COPIED_MS = 2000;

/**
 * Copies a value and says so: a toast, and a tick in place of the copy icon for two seconds.
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
  /** The success toast, when it can say what was copied; defaults to "Copied to clipboard". */
  copiedMessage?: string;
  /** Ghost by default when icon-only, secondary (soft fill) with a label. */
  variant?: "ghost" | "quiet" | "outline" | "secondary";
  /** The icon size; a labelled button is always `sm` (the value "sm" is kept for old callers). */
  size?: "icon" | "icon-sm" | "icon-xs" | "sm";
  showLabel?: boolean;
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
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
    if (!ok) {
      toast.error(t("toast.copyFailed"));
      return;
    }
    toast.success(copiedMessage ?? t("toast.copied"));
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, COPIED_MS);
  };

  const iconOnly = !showLabel;
  const Icon = copied ? CheckIcon : Copy01Icon;
  const button = (
    <Button
      aria-label={iconOnly ? label : undefined}
      className={className}
      data-copied={copied ? "" : undefined}
      onClick={onClick}
      size={iconOnly ? (size === "sm" ? "icon" : size) : "sm"}
      variant={variant ?? (iconOnly ? "ghost" : "secondary")}
    >
      <AnimatedIcon
        icon={Icon}
        aria-hidden="true"
        className={cn(copied && "text-success-foreground")}
        // The tick plays when it lands; the copy icon coming back two seconds later stays still.
        playOnSwap={copied}
      />
      {iconOnly ? null : <span>{copied ? t("toast.copied") : label}</span>}
    </Button>
  );

  if (!iconOnly) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{copied ? t("toast.copied") : label}</TooltipPopup>
    </Tooltip>
  );
}
