import {
  createContext,
  type JSX,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /**
   * `danger` opens with focus on Cancel, so a stray Enter or Space never runs the action. That
   * applies to a keyboard open; opened by a click or a tap, focus goes to the dialog itself (no
   * ring on a button the pointer never touched), and Tab then reaches Cancel first.
   */
  variant?: "danger" | "default";
  /**
   * What the action applies to (an account's email, a backup's time). Callers put it in the
   * title themselves (`t("confirmDelete.title", { email })`); the dialog marks that part so a
   * long value breaks anywhere instead of overflowing.
   */
  target?: string;
}

/** The title with its target, when the title contains it, set apart in its own span. */
function ConfirmTitle({ title, target }: { title: string; target?: string }): JSX.Element {
  const at = target ? title.indexOf(target) : -1;
  if (!target || at < 0) return <>{title}</>;
  return (
    <>
      {title.slice(0, at)}
      {/*
        An inline block: a date and time moves to the next line whole instead of leaving "PM?"
        on its own, and a long email or file name still breaks anywhere inside it.
      */}
      <span className="inline-block max-w-full wrap-anywhere" data-slot="confirm-target">
        {target}
      </span>
      {title.slice(at + target.length)}
    </>
  );
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  // Kept after close so the content does not vanish during the exit transition.
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  // How the last confirm was asked for: confirm() is called from a menu item or a button, so the
  // last keydown or pointerdown before it is what opened the dialog.
  const lastInputRef = useRef<"keyboard" | "pointer">("pointer");
  const openedByKeyboardRef = useRef(false);

  useEffect(() => {
    const onKeyDown = () => {
      lastInputRef.current = "keyboard";
    };
    const onPointerDown = () => {
      lastInputRef.current = "pointer";
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  const settle = useCallback((value: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpen(false);
    resolve?.(value);
  }, []);

  const confirm = useCallback<ConfirmFn>((next) => {
    return new Promise<boolean>((resolve) => {
      // Opening a second confirm settles the first one as cancelled (old UI parity).
      resolverRef.current?.(false);
      resolverRef.current = resolve;
      openedByKeyboardRef.current = lastInputRef.current === "keyboard";
      setOptions(next);
      setOpen(true);
    });
  }, []);

  useEffect(() => () => resolverRef.current?.(false), []);

  // Alert dialogs ignore outside presses; the old confirm treated a backdrop click as Cancel.
  const onPortalClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-slot="alert-dialog-popup"]')) settle(false);
    },
    [settle],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        onOpenChange={(next) => {
          if (!next) settle(false);
        }}
        open={open}
      >
        {options ? (
          <AlertDialogPopup
            initialFocus={(type) =>
              type === "keyboard" || openedByKeyboardRef.current
                ? (options.variant === "danger" ? cancelRef : confirmButtonRef).current
                : popupRef.current
            }
            portalProps={{ onClick: onPortalClick }}
            ref={popupRef}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                <ConfirmTitle target={options.target} title={options.title} />
              </AlertDialogTitle>
              {options.description ? (
                <AlertDialogDescription>{options.description}</AlertDialogDescription>
              ) : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button onClick={() => settle(false)} ref={cancelRef} variant="ghost">
                {options.cancelLabel ?? t("actions.cancel")}
              </Button>
              <Button
                onClick={() => settle(true)}
                ref={confirmButtonRef}
                variant={options.variant === "danger" ? "destructive" : "default"}
              >
                {options.confirmLabel}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        ) : null}
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used within a ConfirmProvider");
  return confirm;
}
