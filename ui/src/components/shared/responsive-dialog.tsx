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
import { useT } from "@/lib/i18n";

export interface ResponsiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Width, named after the Tailwind max-w step (dialog.tsx DIALOG_SIZE_CLASS): sm 384, md 448,
   * lg 512 (the default), xl 576, 2xl 672 px; on phones at most 90vw.
   */
  size?: DialogSize;
  /**
   * `top` hangs the dialog from near the top from sm up, so a step flow or a form that grows (a
   * validation line, a server error) keeps its title in place. Phones always centre it.
   */
  anchor?: DialogAnchor;
  /** Shows a back arrow before the title (a step flow's way back); the footer keeps the actions. */
  onBack?: () => void;
  /** The back arrow's accessible name; defaults to the common "Back". */
  backLabel?: string;
  /**
   * `false` while a request runs: Escape and outside presses do nothing and the close X stays
   * in place but disabled, so the header does not shift.
   */
  dismissible?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
}

/**
 * The title row: an optional back arrow, then the title. The arrow is the close X's size, in a
 * box one title line tall (h-lh at the title's size) that it overflows, so the title sits on the
 * same line with and without it and does not jump between a flow's first step and the next, and
 * the arrow stays on the first line when a long title wraps.
 */
function TitleRow({
  title,
  onBack,
  backLabel,
  Title,
}: {
  title: ReactNode;
  onBack?: () => void;
  backLabel: string;
  Title: typeof DialogTitle;
}): JSX.Element {
  if (!onBack) return <Title>{title}</Title>;
  return (
    <div className="flex min-w-0 items-start gap-1.5" data-slot="responsive-dialog-title-row">
      <span className="flex h-lh shrink-0 items-center text-subtitle">
        <Button
          aria-label={backLabel}
          className="-ms-2 shrink-0"
          onClick={onBack}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon aria-hidden="true" icon={ArrowLeft01Icon} />
        </Button>
      </span>
      <Title className="min-w-0">{title}</Title>
    </div>
  );
}

/**
 * The app's dialog at every width: the coss Dialog, which on phones is a floating panel centred
 * with even gaps, at most 90vw by 90dvh (dialog.tsx), like every other modal. Phones used to get a
 * bottom drawer, which sat 5vw over the bottom edge but far below the top: one centred panel keeps
 * every popup in the same place. Every close path reports onOpenChange(false).
 */
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
  const { t } = useT();
  const back = backLabel ?? t("actions.back");

  const handleOpenChange = (next: boolean, details?: { reason?: string }) => {
    // A non-dismissible dialog closes only through its own buttons.
    if (!next && !dismissible && details?.reason === "escape-key") return;
    onOpenChange(next);
  };

  return (
    <Dialog disablePointerDismissal={!dismissible} onOpenChange={handleOpenChange} open={open}>
      <DialogPopup
        anchor={anchor}
        closeProps={{ disabled: !dismissible }}
        initialFocus={initialFocus}
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
