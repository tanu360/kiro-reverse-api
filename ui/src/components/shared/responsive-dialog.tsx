import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX, ReactNode, RefObject } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  type DialogAnchor,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  type DialogSize,
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
import { useT } from "@/lib/i18n";

export interface ResponsiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Width from md up, named after the Tailwind max-w step (dialog.tsx DIALOG_SIZE_CLASS):
   * sm 384, md 448, lg 512 (the default), xl 576, 2xl 672 px.
   */
  size?: DialogSize;
  /** `top` hangs the dialog from near the top, so a step flow keeps its title in place. */
  anchor?: DialogAnchor;
  /** Shows a back arrow before the title (a step flow's way back); the footer keeps the actions. */
  onBack?: () => void;
  /** The back arrow's accessible name; defaults to "Go back". */
  backLabel?: string;
  dismissible?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
}

/** The title row: an optional back arrow, then the title. */
function TitleRow({
  title,
  onBack,
  backLabel,
  Title,
}: {
  title: ReactNode;
  onBack?: () => void;
  backLabel: string;
  Title: typeof DialogTitle | typeof DrawerTitle;
}): JSX.Element {
  if (!onBack) return <Title>{title}</Title>;
  return (
    <div className="flex min-w-0 items-center gap-1.5" data-slot="responsive-dialog-title-row">
      <Button
        aria-label={backLabel}
        className="-ms-2 shrink-0"
        onClick={onBack}
        size="icon-sm"
        variant="ghost"
      >
        <HugeiconsIcon aria-hidden="true" icon={ArrowLeft01Icon} />
      </Button>
      <Title className="min-w-0">{title}</Title>
    </div>
  );
}

/** coss Dialog from `md` up, a bottom Drawer below it. Every close path reports onOpenChange(false). */
export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "lg",
  anchor = "center",
  onBack,
  backLabel,
  dismissible = true,
  initialFocus,
}: ResponsiveDialogProps): JSX.Element {
  const isMobile = useIsMobile();
  const { t } = useT();
  const back = backLabel ?? t("shell.notFound.back");

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
            <TitleRow backLabel={back} onBack={onBack} title={title} Title={DrawerTitle} />
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
        anchor={anchor}
        initialFocus={initialFocus}
        showCloseButton={dismissible}
        size={size}
      >
        <DialogHeader>
          <TitleRow backLabel={back} onBack={onBack} title={title} Title={DialogTitle} />
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel>{children}</DialogPanel>
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogPopup>
    </Dialog>
  );
}
