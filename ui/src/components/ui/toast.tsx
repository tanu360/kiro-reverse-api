"use client";

// coss ui toast (https://coss.com/ui/docs/components/toast), added with the shadcn CLI from @coss.
// Kiro patches: Hugeicons instead of lucide-react (the project's icon library), a translated
// region label from the `ui` namespace, the one floating sheet (index.css popup-surface), a close
// button on every toast, the page gutter as its inset, room under the app header
// (--toast-top-offset) and above the batch bar (--toast-stack-offset), a place under the
// modal layer while a dialog, sheet or drawer is open, no shadow, an 8 px stack gap, and the
// title in its icon's colour.
import { Toast } from "@base-ui/react/toast";
import {
  AlertCircleIcon,
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type React from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { useUiT } from "@/components/ui/messages";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const TOAST_ICONS = {
  error: AlertCircleIcon,
  info: InfoIcon,
  loading: LoaderCircleIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

type SwipeDirection = "up" | "down" | "left" | "right";

/*
 * Toasts float above the page (z-60) but drop under the modal layer (z-50) while a dialog, alert
 * dialog, sheet, drawer, the command palette or the phone sidebar is open, so they never cover a
 * modal's buttons; the modal's backdrop dims them like the rest of the page. Anchored popups
 * (menus, selects, popovers, tooltips) sit above both at z-70, so a toast never covers one.
 */
const UNDER_MODALS =
  "[body:has([data-slot=dialog-popup],[data-slot=alert-dialog-popup],[data-slot=sheet-popup],[data-slot=drawer-popup],[data-slot=command-dialog-popup],[data-slot=sidebar][data-mobile=true])_&]:z-40";

/**
 * The toast's tone: the status icon and the title share one text colour, the type's readable
 * foreground (the pill text tokens). Loading and untyped toasts keep the popover text colour.
 */
const TOAST_TONE_CLASS =
  "in-data-[type=error]:text-destructive-foreground in-data-[type=info]:text-info-foreground in-data-[type=success]:text-success-foreground in-data-[type=warning]:text-warning-foreground";

/** The toast body: icon, title and description, then the action and the close button. */
function ToastBody({
  icon,
  action,
}: {
  icon: (typeof TOAST_ICONS)[keyof typeof TOAST_ICONS] | null;
  action: React.ReactNode;
}): React.ReactElement {
  const { t } = useT();
  return (
    <>
      <div className="flex min-w-0 gap-2">
        {icon && (
          <div className="[&>svg]:h-lh [&>svg]:w-4 icon-slot" data-slot="toast-icon">
            <HugeiconsIcon
              aria-hidden="true"
              className={cn("in-data-[type=loading]:animate-spin", TOAST_TONE_CLASS)}
              icon={icon}
            />
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <Toast.Title
            className={cn("wrap-anywhere font-medium", TOAST_TONE_CLASS)}
            data-slot="toast-title"
          />
          <Toast.Description
            className="wrap-anywhere text-muted-foreground"
            data-slot="toast-description"
          />
        </div>
      </div>
      <div className="-me-1.5 flex shrink-0 items-center gap-1">
        {action}
        <Toast.Close
          aria-label={t("actions.close")}
          data-slot="toast-close"
          render={<Button size="icon-xs" variant="quiet" />}
        >
          <HugeiconsIcon aria-hidden="true" icon={XIcon} />
        </Toast.Close>
      </div>
    </>
  );
}

type ToastData = {
  rootProps?: Omit<
    React.ComponentProps<typeof Toast.Root>,
    "children" | "className" | "swipeDirection" | "toast"
  >;
  tooltipStyle?: boolean;
};

function getSwipeDirection(position: ToastPosition): SwipeDirection[] {
  const verticalDirection: SwipeDirection = position.startsWith("top") ? "up" : "down";

  if (position.includes("center")) {
    return [verticalDirection];
  }

  if (position.includes("left")) {
    return ["left", verticalDirection];
  }

  return ["right", verticalDirection];
}

function upsertReplayClassName(toast: { type?: string; updateKey?: number }): string | undefined {
  const k = toast.updateKey ?? 0;
  if (k <= 0) return undefined;
  const isEven = k % 2 === 0;
  if (toast.type === "error") {
    return isEven ? "animate-toast-error-even" : "animate-toast-error-odd";
  }
  return isEven ? "animate-toast-success-even" : "animate-toast-success-odd";
}

function Toasts({
  position,
  portalProps,
}: {
  position: ToastPosition;
  portalProps?: React.ComponentProps<typeof Toast.Portal>;
}): React.ReactElement {
  const { t } = useUiT();
  const { toasts } = Toast.useToastManager();
  const swipeDirection = getSwipeDirection(position);

  return (
    <Toast.Portal data-slot="toast-portal" {...portalProps}>
      <Toast.Viewport
        aria-label={t("toast.region")}
        className={cn(
          // The page gutter: 16 px, 24 px from md up, so a toast lines up with the content column.
          // Phones (below sm) keep the modal gap (5vw, index.css), so a toast is at most 90vw.
          "fixed z-60 mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-90 [--toast-inset:--spacing(4)] max-sm:[--toast-inset:max(--spacing(4),var(--modal-gap-x))] md:[--toast-inset:--spacing(6)]",
          UNDER_MODALS,
          // Vertical positioning. Top toasts hang under the app's sticky header (index.css
          // --toast-top-offset); bottom toasts clear the batch bar (--toast-stack-offset).
          "data-[position*=top]:top-[calc(var(--toast-inset)+var(--toast-top-offset,0px))]",
          "data-[position*=bottom]:bottom-[calc(var(--toast-inset)+var(--toast-stack-offset,0px))]",
          // Horizontal positioning
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-(--toast-inset)",
          "data-[position*=center]:left-1/2 data-[position*=center]:-translate-x-1/2",
        )}
        data-position={position}
        data-slot="toast-viewport"
      >
        {toasts.map((toast) => {
          const Icon = toast.type ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS] : null;
          const toastData = toast.data as ToastData | undefined;

          return (
            <Toast.Root
              key={toast.id}
              className={cn(
                "popup-surface absolute z-[calc(9999-var(--toast-index))] h-(--toast-calc-height) w-full select-none [--popup-shadow:none] [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s]",
                // Base positioning using data-position
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-[50%_calc(50%-50%*min(var(--toast-index,0),1))]",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-[50%_calc(50%+50%*min(var(--toast-index,0),1))]",
                // Gap fill for hover
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                // Define some variables
                "[--toast-calc-height:var(--toast-frontmost-height,var(--toast-height))] [--toast-gap:--spacing(2)] [--toast-peek:--spacing(2)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.1)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                // Define offset-y variable
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                // Default state transform
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                // Limited state
                "data-limited:opacity-0",
                // Expanded state
                "data-expanded:h-(--toast-height)",
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                // Starting and ending animations
                "motion-safe:data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)-var(--toast-top-offset,0px)))]",
                "motion-safe:data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-ending-style:opacity-0",
                // Ending animations (direction-aware)
                "motion-safe:data-[position*=top]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(-100%-var(--toast-inset)-var(--toast-top-offset,0px)))]",
                "motion-safe:data-[position*=bottom]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                // Ending animations (expanded)
                "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                upsertReplayClassName(toast),
              )}
              {...toastData?.rootProps}
              data-position={position}
              data-slot="toast"
              swipeDirection={swipeDirection}
              toast={toast}
            >
              <Toast.Content className="pointer-events-auto flex items-center justify-between gap-3 overflow-hidden px-3.5 py-3 text-sm transition-opacity duration-250 data-behind:not-data-expanded:pointer-events-none data-behind:opacity-0 data-expanded:opacity-100">
                <ToastBody
                  action={
                    toast.actionProps && (
                      <Toast.Action
                        className={buttonVariants({ size: "sm" })}
                        data-slot="toast-action"
                      >
                        {toast.actionProps.children}
                      </Toast.Action>
                    )
                  }
                  icon={Icon}
                />
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export const toastManager: ReturnType<typeof Toast.createToastManager> = Toast.createToastManager();

type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

interface ToastProviderProps extends Toast.Provider.Props {
  position?: ToastPosition;
  portalProps?: React.ComponentProps<typeof Toast.Portal>;
}

export function ToastProvider({
  children,
  position = "bottom-right",
  portalProps,
  ...props
}: ToastProviderProps): React.ReactElement {
  return (
    <Toast.Provider toastManager={toastManager} {...props}>
      {children}
      <Toasts portalProps={portalProps} position={position} />
    </Toast.Provider>
  );
}
