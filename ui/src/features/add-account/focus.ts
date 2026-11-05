import { type RefObject, useCallback, useEffect, useState } from "react";

/** An element to focus: a ref, or a lookup that runs once the next step has rendered. */
export type FocusTarget = RefObject<HTMLElement | null> | (() => HTMLElement | null | undefined);

/** Focuses `element` and scrolls its whole field (label, control, error) into view. */
export function focusField(element: HTMLElement | null | undefined): void {
  if (!element) return;
  element.focus();
  // On phones the drawer body scrolls; keep the error under the control in view as well.
  element.closest<HTMLElement>('[data-slot="field"]')?.scrollIntoView?.({ block: "nearest" });
}

const STEP_CONTROLS = 'input:not([type="hidden"]), textarea, select, button, [role="combobox"]';

/** The first enabled form control in a step, skipping hidden helpers such as file inputs. */
export function firstStepControl(root: HTMLElement): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(STEP_CONTROLS)) {
    if (element.tabIndex < 0 || element.matches(":disabled") || element.closest("[hidden]")) {
      continue;
    }
    return element;
  }
  return null;
}

/** True on touch screens, where a focused text field opens the on-screen keyboard. */
export function isCoarsePointer(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

/**
 * The target for a step change inside a flow: `control` with a mouse or keyboard; on touch
 * screens the step's form itself (it needs `tabIndex={-1}`). A focused text field there would
 * open the keyboard over the drawer just as the user has to tap the sign-in link above it, the
 * same rule the dialog follows when a flow opens. Errors still focus the field to fix.
 */
export function stepFocus(formId: string, control: FocusTarget): FocusTarget {
  return () => {
    if (isCoarsePointer()) return document.getElementById(formId);
    return typeof control === "function" ? control() : control.current;
  };
}

/**
 * Returns `focusAfter(target)`, which focuses `target` after the next render in which `busy` is
 * false. Controls are disabled while a request runs and a new step mounts its controls a render
 * later, so focusing right away would land on nothing and leave focus on `<body>`. Flows call it
 * after a failed submit (the field to fix) and after a step change (the new step's first control).
 */
export function useFocusAfter(busy: boolean): (target: FocusTarget) => void {
  const [request, setRequest] = useState<{ target: FocusTarget; done: boolean } | null>(null);

  useEffect(() => {
    if (busy || !request || request.done) return;
    request.done = true;
    const { target } = request;
    focusField(typeof target === "function" ? target() : target.current);
  }, [busy, request]);

  return useCallback((target: FocusTarget) => setRequest({ target, done: false }), []);
}
