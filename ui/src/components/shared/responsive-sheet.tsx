import { type ComponentProps, type JSX, type ReactNode, type RefObject, useRef } from "react";
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

export interface ResponsiveSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
  /**
   * Where focus lands on open. Defaults to the sheet itself: the first field would open the
   * on-screen keyboard over half the sheet on phones, and a first copy button would show its
   * tooltip and spend the first Escape closing it. Tab still reaches the first control.
   */
  initialFocus?: RefObject<HTMLElement | null>;
  showCloseButton?: boolean;
}

/**
 * The one detail sheet: from md up a right sheet 576 px wide; below md a bottom sheet that fills
 * the screen under a 48 px strip, with 16 px top corners. Compose it with the parts below.
 */
export function ResponsiveSheet({
  open,
  onOpenChange,
  children,
  className,
  initialFocus,
  showCloseButton = true,
}: ResponsiveSheetProps): JSX.Element {
  const isMobile = useIsMobile();
  const popupRef = useRef<HTMLDivElement | null>(null);

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup
        className={cn(
          "outline-none",
          isMobile ? "h-full rounded-t-2xl" : "max-w-none sm:max-w-xl",
          className,
        )}
        data-responsive-side={isMobile ? "bottom" : "right"}
        initialFocus={initialFocus ?? popupRef}
        ref={popupRef}
        showCloseButton={showCloseButton}
        side={isMobile ? "bottom" : "right"}
      >
        {children}
      </SheetPopup>
    </Sheet>
  );
}

export {
  SheetDescription as ResponsiveSheetDescription,
  SheetHeader as ResponsiveSheetHeader,
  SheetPanel as ResponsiveSheetPanel,
  SheetTitle as ResponsiveSheetTitle,
};

/** The sheet's foot. `split` (the default) puts a status at the start and actions at the end. */
export function ResponsiveSheetFooter({
  variant = "split",
  ...props
}: ComponentProps<typeof SheetFooter>): JSX.Element {
  return <SheetFooter variant={variant} {...props} />;
}
