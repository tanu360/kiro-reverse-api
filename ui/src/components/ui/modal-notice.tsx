import { AlertCircleIcon, TriangleAlertIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/*
 * While a dialog, alert dialog or sheet is open, toasts sit under the modal layer and its blurred
 * backdrop (toast.tsx), so they never cover the modal's buttons; a toast raised there cannot be
 * read. So an error or warning toast raised while a modal is open also shows in the modal itself,
 * as a notice line over its footer (lib/toast.ts calls showInOpenModal). The toast is still
 * there once the modal closes, so a message raised as its dialog closes is never lost.
 */

export interface ModalNoticeData {
  type: "error" | "warning";
  title: string;
  description?: string;
}

/** An open modal's notice line. */
export interface ModalNoticeSlot {
  /** Mounted and open: not closing. */
  isOpen: () => boolean;
  show: (notice: ModalNoticeData) => void;
}

/** The modals with a notice line, in the order they opened: a nested one comes after its parent. */
const slots: ModalNoticeSlot[] = [];

/** The newest open modal's line, or undefined while no modal is open. */
export function openModalSlot(): ModalNoticeSlot | undefined {
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    if (slots[index].isOpen()) return slots[index];
  }
  return undefined;
}

/** Shows the notice in the newest open modal; false when no modal is open. */
export function showInOpenModal(notice: ModalNoticeData): boolean {
  const slot = openModalSlot();
  slot?.show(notice);
  return slot !== undefined;
}

interface HostContext {
  notice: ModalNoticeData | null;
  /** A footer shows the line over itself; returns its unregister. */
  addFooter: () => () => void;
}

const ModalNoticeContext = createContext<HostContext | null>(null);

/** Input types that take typed text (a text field, not a radio, checkbox or range). */
const PICK_TYPES = new Set(["checkbox", "radio", "range", "color", "file", "button", "submit"]);

function isTyping(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return !PICK_TYPES.has(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}

/** The line itself: the modal's side padding, 16 px above what follows. */
function NoticeLine({ notice }: { notice: ModalNoticeData }): JSX.Element {
  return (
    <div className="px-6 pb-4 max-sm:px-4" data-slot="modal-notice">
      <Alert variant={notice.type}>
        <HugeiconsIcon
          aria-hidden="true"
          icon={notice.type === "error" ? AlertCircleIcon : TriangleAlertIcon}
        />
        {notice.description ? (
          <>
            <AlertTitle className="wrap-break-word">{notice.title}</AlertTitle>
            <AlertDescription className="wrap-break-word">{notice.description}</AlertDescription>
          </>
        ) : (
          <AlertDescription className="wrap-break-word">{notice.title}</AlertDescription>
        )}
      </Alert>
    </div>
  );
}

/**
 * Wraps a modal popup's content (a direct child of the popup element). The line shows over the
 * modal's footer (ModalNoticeOutlet, rendered by every footer, also inside a form), or at the
 * modal's end when it has no footer. Typing in the modal or sending its form again clears it:
 * the message no longer applies.
 */
export function ModalNoticeHost({ children }: { children: ReactNode }): JSX.Element {
  const anchor = useRef<HTMLSpanElement | null>(null);
  const [notice, setNotice] = useState<ModalNoticeData | null>(null);
  const [footers, setFooters] = useState(0);

  useEffect(() => {
    const popup = anchor.current?.parentElement ?? null;
    const slot: ModalNoticeSlot = {
      // Base UI marks an open popup data-open; a closing one is data-closed until it unmounts.
      isOpen: () => popup?.isConnected === true && popup.hasAttribute("data-open"),
      show: setNotice,
    };
    slots.push(slot);
    const clear = () => setNotice(null);
    // Typing, not a pick: a radio or checkbox fires its input event after the click that may
    // have raised the notice.
    const clearOnTyping = (event: Event) => {
      if (isTyping(event.target)) clear();
    };
    popup?.addEventListener("input", clearOnTyping, true);
    popup?.addEventListener("submit", clear, true);
    return () => {
      slots.splice(slots.indexOf(slot), 1);
      popup?.removeEventListener("input", clearOnTyping, true);
      popup?.removeEventListener("submit", clear, true);
    };
  }, []);

  const addFooter = useCallback(() => {
    setFooters((count) => count + 1);
    return () => setFooters((count) => count - 1);
  }, []);
  const context = useMemo<HostContext>(() => ({ notice, addFooter }), [notice, addFooter]);

  return (
    <ModalNoticeContext.Provider value={context}>
      {children}
      {/* Always rendered (display: none), so the effect above finds the popup it sits in. */}
      <span hidden ref={anchor} />
      {notice && footers === 0 ? <NoticeLine notice={notice} /> : null}
    </ModalNoticeContext.Provider>
  );
}

/** Rendered by a modal footer just before itself: the notice line, while there is one. */
export function ModalNoticeOutlet(): JSX.Element | null {
  const context = useContext(ModalNoticeContext);
  const addFooter = context?.addFooter;
  useLayoutEffect(() => addFooter?.(), [addFooter]);
  return context?.notice ? <NoticeLine notice={context.notice} /> : null;
}
