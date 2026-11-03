import { CheckIcon, CopyIcon } from "lucide-react";
import { type JSX, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const COPIED_MS = 2000;

export function CopyButton({
  value,
  label,
  variant = "ghost",
  size = "icon",
  showLabel = false,
  className,
}: {
  value: string | (() => Promise<string>);
  label: string;
  variant?: "ghost" | "outline";
  size?: "icon" | "sm";
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
    toast.success(t("toast.copied"));
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, COPIED_MS);
  };

  const iconOnly = !showLabel || size === "icon";
  const Icon = copied ? CheckIcon : CopyIcon;
  const button = (
    <Button
      aria-label={iconOnly ? label : undefined}
      className={cn(size === "icon" && "size-10 md:size-8", className)}
      data-copied={copied ? "" : undefined}
      onClick={onClick}
      size={size}
      variant={variant}
    >
      <Icon aria-hidden="true" className={cn(copied && "text-success-foreground")} />
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
