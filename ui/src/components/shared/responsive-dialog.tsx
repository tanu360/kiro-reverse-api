import type { JSX, ReactNode, RefObject } from "react";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerPanel,
  DrawerPopup,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

export interface ResponsiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  dismissible?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
}

const SIZE_CLASS: Record<NonNullable<ResponsiveDialogProps["size"]>, string> = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  xl: "sm:max-w-4xl",
};

/** coss Dialog from `md` up, a bottom Drawer below it. Every close path reports onOpenChange(false). */
export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissible = true,
  initialFocus,
}: ResponsiveDialogProps): JSX.Element {
  const isMobile = useIsMobile();

  const handleOpenChange = (next: boolean, details?: { reason?: string }) => {
    // A non-dismissible dialog closes only through its own buttons.
    if (!next && !dismissible && details?.reason === "escape-key") return;
    onOpenChange(next);
  };

  if (isMobile) {
    return (
      <Drawer
        disablePointerDismissal={!dismissible}
        onOpenChange={handleOpenChange}
        open={open}
        position="bottom"
      >
        <DrawerPopup className="max-h-[90dvh]" initialFocus={initialFocus} showBar>
          <DrawerHeader>
            <DrawerTitle className="font-medium text-lg">{title}</DrawerTitle>
            {description ? <DrawerDescription>{description}</DrawerDescription> : null}
          </DrawerHeader>
          <DrawerPanel className="min-h-0">{children}</DrawerPanel>
          {footer ? <DrawerFooter>{footer}</DrawerFooter> : null}
        </DrawerPopup>
      </Drawer>
    );
  }

  return (
    <Dialog disablePointerDismissal={!dismissible} onOpenChange={handleOpenChange} open={open}>
      <DialogPopup
        className={cn(SIZE_CLASS[size])}
        initialFocus={initialFocus}
        showCloseButton={dismissible}
      >
        <DialogHeader>
          <DialogTitle className="font-medium text-lg">{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel>{children}</DialogPanel>
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogPopup>
    </Dialog>
  );
}
