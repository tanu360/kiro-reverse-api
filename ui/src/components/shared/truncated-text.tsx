import { type JSX, useRef, useState } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * One line of text cut to its box with an ellipsis. The full text is a tooltip, shown only when
 * the text is actually cut off (the Accounts email cell does the same).
 */
export function TruncatedText({
  children,
  className,
}: {
  children: string;
  className?: string;
}): JSX.Element {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      onOpenChange={(next) => {
        const element = ref.current;
        setOpen(next && element !== null && element.scrollWidth > element.clientWidth);
      }}
      open={open}
    >
      <TooltipTrigger
        render={<span className={cn("block min-w-0 truncate", className)} ref={ref} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{children}</TooltipPopup>
    </Tooltip>
  );
}
