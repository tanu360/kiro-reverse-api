import { Alert02Icon, CheckIcon, FloppyDiskIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type UseQueryResult, useMutation } from "@tanstack/react-query";
import {
  cloneElement,
  createContext,
  type FormEvent,
  type JSX,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { ActionError } from "@/components/shared/action-error";
import { ErrorState } from "@/components/shared/error-state";
import { InfoHint } from "@/components/shared/info-hint";
import { type SectionCardProps, SettingsFrame } from "@/components/shared/section-card";
import {
  SETTINGS_ROW_X,
  SaveButton as SharedSaveButton,
  SaveFooter as SharedSaveFooter,
} from "@/components/shared/settings-rows";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { useSavedFlash } from "@/hooks/use-saved-flash";
import { announce } from "@/lib/announce";
import { errorMessage } from "@/lib/api/server-errors";
import { fillNodes, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useReportDirty } from "../lib/unsaved";
import { SETTINGS_SECTIONS } from "./sections";

/*
 * The Settings page's glue on top of the shared settings kit (components/shared/settings-rows and
 * section-card): each card's form, its save state reported to the page, its load states and the
 * hint helpers. The rows, the save footer and the card chrome themselves are the shared ones.
 */

/** The id of the settings card a control sits in, so Save can report its card as dirty. */
const SectionIdContext = createContext<string | undefined>(undefined);

/** How a card's save went, for its SaveFooter: Save's "Saved" moment and a failure to show. */
export interface SaveFeedback {
  saving: boolean;
  /** Just saved: Save reads "Saved" for a moment (useSavedFlash). */
  saved: boolean;
  /** The last save's failure, until the next save or `dismiss`; null when none is shown here. */
  error: unknown;
  dismiss: () => void;
}

/**
 * One card's save: on success it calls `onSaved`, Save reads "Saved" for a moment and a screen
 * reader hears "Your settings were saved." On failure it calls `onFailed`, and the reason shows
 * in the card (`feedback.error`) until the next save; an `onFailed` that returns true has shown
 * it at the field itself, so the card shows nothing more and the reason is only read out. The
 * API client throws on any non-2xx.
 */
export function useSectionSave<V>(
  save: (variables: V) => Promise<unknown>,
  handlers: {
    onSaved: (variables: V) => void;
    /** Returns true when it showed the reason at a field itself. */
    onFailed?: (error: unknown, variables: V) => unknown;
  },
): { save: (variables: V) => void; saving: boolean; feedback: SaveFeedback } {
  const { t } = useT("settings");
  const savedFlash = useSavedFlash();
  const [shownAtField, setShownAtField] = useState(false);
  const mutation = useMutation({
    mutationFn: save,
    onMutate: () => {
      setShownAtField(false);
      savedFlash.clear();
    },
    onSuccess: (_data, variables) => {
      handlers.onSaved(variables);
      savedFlash.flash();
      announce(t("common:form.saved"));
    },
    onError: (error, variables) => {
      if (handlers.onFailed?.(error, variables) !== true) return;
      setShownAtField(true);
      announce(errorMessage(error, t), { assertive: true });
    },
  });
  const failed = mutation.isError && !shownAtField;
  return {
    save: mutation.mutate,
    saving: mutation.isPending,
    feedback: {
      saving: mutation.isPending,
      saved: savedFlash.saved,
      error: failed ? mutation.error : null,
      dismiss: mutation.reset,
    },
  };
}

/** A row's controls, in the order focus prefers them. */
const ROW_CONTROLS = [
  '[role="switch"]',
  '[role="combobox"]',
  '[role="radio"][aria-checked="true"]',
  'input:not([type="hidden"])',
  "button",
];

/** Focuses the control of a settings row: its switch, select, chosen segment or field. */
function focusRowControl(row: HTMLElement | null | undefined): void {
  if (!row) return;
  for (const selector of ROW_CONTROLS) {
    const control = [...row.querySelectorAll<HTMLElement>(selector)].find(
      (element) => !element.closest('[data-slot="action-error"]'),
    );
    if (control) {
      control.focus();
      return;
    }
  }
}

/**
 * A failed action of one row (a switch or a select that saves as it is set, a test, a reset), as
 * the row's `notice`, across the whole row: the reason with Try again and close. Either one puts
 * focus back on the row's control (`focusTarget`, else the row's switch, select, chosen segment
 * or first button) before the notice goes, so it never drops to the page.
 */
export function RowActionError({
  error,
  onRetry,
  onDismiss,
  focusTarget,
}: {
  error: unknown;
  onRetry: () => void;
  onDismiss: () => void;
  focusTarget?: RefObject<HTMLElement | null>;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const row = () => ref.current?.closest<HTMLElement>('[data-slot="settings-row"]');
  const refocus = () => {
    if (focusTarget?.current) focusTarget.current.focus();
    else focusRowControl(row());
  };
  return (
    <div className="min-w-0" ref={ref}>
      <ActionError
        error={error}
        onDismiss={() => {
          refocus();
          onDismiss();
        }}
        onRetry={() => {
          refocus();
          onRetry();
          // A segment that takes the pick again moves the choice: focus follows it.
          if (!focusTarget) {
            const element = row();
            setTimeout(() => focusRowControl(element), 0);
          }
        }}
      />
    </div>
  );
}

/**
 * A failed save in a card's footer, over the save line: the reason, Try again (Save again, with
 * the draft kept) and close. Both put focus on Save.
 */
export function FooterSaveError({
  error,
  saveRef,
  onDismiss,
}: {
  error: unknown;
  saveRef: RefObject<HTMLButtonElement | null>;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <ActionError
      error={error}
      onDismiss={() => {
        saveRef.current?.focus();
        onDismiss();
      }}
      onRetry={() => {
        saveRef.current?.focus();
        saveRef.current?.click();
      }}
    />
  );
}

/** How long a dialog's Save reads "Saved" before the dialog closes. */
const SAVED_CLOSE_MS = 700;

/**
 * A dialog that closes on a save: `done()` turns its Save to "Saved", and `close` runs a moment
 * later, so the result is seen before the dialog goes. `reset()` (on the next open) clears it.
 */
export function useSavedThenClose(close: () => void): {
  saved: boolean;
  done: () => void;
  reset: () => void;
} {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return {
    saved,
    done: () => {
      if (timer.current) clearTimeout(timer.current);
      setSaved(true);
      timer.current = setTimeout(() => {
        timer.current = null;
        closeRef.current();
      }, SAVED_CLOSE_MS);
    },
    reset: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setSaved(false);
    },
  };
}

/**
 * A dialog's Save (submit): "Saving…" with a spinner, then "Saved" with a tick at full strength
 * while the dialog closes (useSavedThenClose); the form must ignore a submit meanwhile.
 */
export function DialogSaveButton({
  saving,
  saved,
  ref,
}: {
  saving: boolean;
  saved: boolean;
  ref?: Ref<HTMLButtonElement>;
}): JSX.Element {
  const { t } = useT();
  return (
    <Button
      aria-disabled={saved || undefined}
      className={cn(saved && "aria-disabled:not-aria-busy:opacity-100")}
      loading={saving}
      loadingText={t("actions.saving")}
      ref={ref}
      type="submit"
    >
      <HugeiconsIcon icon={saved ? CheckIcon : FloppyDiskIcon} aria-hidden="true" />
      {saved ? t("actions.saved") : t("actions.save")}
    </Button>
  );
}

/**
 * A hint of at most two sentences, with the rest behind the "Learn more" (InfoHint's
 * link look) at its end.
 */
export function Hint({ children, more }: { children: ReactNode; more?: ReactNode }): JSX.Element {
  const { t } = useT("settings");
  if (!more) return <>{children}</>;
  // Joined the language's way: a space in English, none after "。" in Chinese.
  return (
    <>
      {fillNodes(t("common:text.joinSentences"), {
        first: children,
        second: (
          <InfoHint hint={more} variant="link">
            {t("learnMore")}
          </InfoHint>
        ),
      })}
    </>
  );
}

/** Save that also marks its card as unsaved in the section nav and the leave-page guard. */
function SaveButton({
  dirty,
  saving,
  saved,
  ref,
}: {
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  ref: Ref<HTMLButtonElement>;
}): JSX.Element {
  useReportDirty(useContext(SectionIdContext), dirty);
  return <SharedSaveButton dirty={dirty} ref={ref} saved={saved} saving={saving} />;
}

/**
 * A card's footer: the shared save state ("Unsaved changes", or the server-changed notice in its
 * place), an optional note under it, and Save, which reads "Saved" for a moment after a save. A
 * failed save shows over that line while the draft is still unsaved.
 */
export function SaveFooter({
  dirty,
  feedback,
  serverChanged = false,
  onReload,
  note,
}: {
  dirty: boolean;
  feedback: SaveFeedback;
  serverChanged?: boolean;
  onReload: () => void;
  note?: ReactNode;
}): JSX.Element {
  const saveRef = useRef<HTMLButtonElement>(null);
  const failed = dirty && feedback.error != null;
  // A draft back to the saved values (undone, or Reload) ends the failure: the next edit must not
  // bring the old reason back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the draft turns clean.
  useEffect(() => {
    if (!dirty && feedback.error != null) feedback.dismiss();
  }, [dirty]);
  return (
    <>
      {failed ? (
        <FooterSaveError error={feedback.error} onDismiss={feedback.dismiss} saveRef={saveRef} />
      ) : null}
      <SharedSaveFooter
        action={
          <SaveButton dirty={dirty} ref={saveRef} saved={feedback.saved} saving={feedback.saving} />
        }
        dirty={dirty}
        note={note}
        status={serverChanged ? <ServerChangedNotice onReload={onReload} /> : undefined}
      />
    </>
  );
}

/** The saved value changed on the server while this card was edited: Reload takes it. */
function ServerChangedNotice({ onReload }: { onReload: () => void }): JSX.Element {
  const { t } = useT("settings");
  return (
    <Alert role="status" size="sm" variant="warning">
      <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
      <AlertDescription>{t("serverChanged")}</AlertDescription>
      <AlertAction>
        <Button onClick={onReload} variant="link-inline">
          {t("reload")}
        </Button>
      </AlertAction>
    </Alert>
  );
}

/**
 * A Settings card: the shared SettingsFrame with the section's nav icon in its chip, looked up by
 * `id`. Every card, the danger zone too, is the plain one: there only its button is red. Rows go
 * in as direct children.
 */
export function SettingsGroup({
  id,
  ...props
}: Omit<SectionCardProps, "icon" | "tone" | "id"> & {
  id: string;
  /** After the title: a count or a state. */
  badge?: ReactNode;
}): JSX.Element {
  const section = SETTINGS_SECTIONS.find((item) => item.id === id);
  return (
    <SettingsFrame
      // Below xl the sticky section chips sit under the header: a jump lands below both.
      className="max-xl:scroll-mt-30"
      icon={section?.icon}
      id={id}
      {...props}
    />
  );
}

/**
 * Focuses the form's first field marked invalid, unless focus is in one, and scrolls it to the
 * middle of the view: at the top edge it would hide under the sticky header.
 */
function focusFirstInvalidField(form: HTMLFormElement): void {
  const field = form.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!field || field.contains(document.activeElement)) return;
  field.focus({ preventScroll: true });
  field.scrollIntoView?.({ block: "center" });
}

/**
 * A settings section in its own form: Enter in a field submits it, and Save is the submit
 * button. `hint` is at most two sentences; `learnMore` holds the rest behind a popover. The
 * children are rows (SettingsRow, SwitchField), each under a hairline; the footer holds Save.
 */
export function SettingsSection({
  id,
  title,
  badge,
  hint,
  learnMore,
  actions,
  footer,
  onSubmit,
  children,
}: {
  id: string;
  title: string;
  badge?: ReactNode;
  hint?: ReactNode;
  learnMore?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  onSubmit?: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <SectionIdContext.Provider value={id}>
      <form
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = event.currentTarget;
          onSubmit?.();
          // Save on a card whose refused field is scrolled away showed nothing: take the user to it.
          window.setTimeout(() => focusFirstInvalidField(form), 0);
        }}
      >
        <SettingsGroup
          actions={actions}
          badge={badge}
          description={hint || learnMore ? <Hint more={learnMore}>{hint}</Hint> : undefined}
          footer={footer}
          id={id}
          title={title}
        >
          {children}
        </SettingsGroup>
      </form>
    </SectionIdContext.Provider>
  );
}

/**
 * Skeleton while the section's query loads, an error with Retry when its first load fails ("Could
 * not load {section} settings"), both under the section's heading. A refetch that fails keeps the
 * copy already shown, and the unsaved edits made on it. A section built on the shared GET
 * /settings query (`shared`) shows no error of its own: the page shows one for all of them, and
 * the section leaves only a hidden anchor (the nav then goes to the page error).
 */
export function SectionQuery<T>({
  id,
  title,
  query,
  shared = false,
  children,
}: {
  id: string;
  title: string;
  query: UseQueryResult<T>;
  shared?: boolean;
  children: (data: T) => ReactNode;
}): JSX.Element {
  const { t } = useT("settings");
  if (query.isPending) {
    return (
      <SettingsGroup id={id} title={title}>
        <div aria-hidden="true" className={cn(SETTINGS_ROW_X, "flex flex-col gap-2 py-4")}>
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="mt-1 h-6 w-2/5" />
        </div>
      </SettingsGroup>
    );
  }
  if (query.data === undefined) {
    if (shared) return <div hidden id={id} />;
    return (
      <SettingsGroup id={id} title={title}>
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
          title={t("loadSectionFailed")}
        />
      </SettingsGroup>
    );
  }
  return <>{children(query.data)}</>;
}

type AriaProps = { "aria-labelledby"?: string; "aria-describedby"?: string };

/** Joins id lists for aria-describedby, dropping empty ones. */
function joinIds(...ids: Array<string | undefined>): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined === "" ? undefined : joined;
}

/**
 * A row's control with its error under it, as one Base UI Field: the row's label and description
 * (which SettingsRow puts on its `control`) reach the input, the field marks it invalid, and the
 * error joins its description.
 */
export function FieldControl({
  error,
  children,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
}: AriaProps & {
  error: string | null;
  children: ReactElement<AriaProps>;
}): JSX.Element {
  return (
    <Field className="w-full items-stretch gap-1.5" invalid={error !== null}>
      {cloneElement(children, {
        "aria-labelledby": joinIds(children.props["aria-labelledby"], labelledBy),
        "aria-describedby": joinIds(children.props["aria-describedby"], describedBy),
      })}
      {error === null ? null : <FieldError match>{error}</FieldError>}
    </Field>
  );
}

/**
 * A row's button laid out as an actions control (SettingsRow `controlWidth="actions"`): under
 * the text on a narrow row, so the description keeps the row's width, and at the row's end beside
 * the text, at its own width, on a wide one. The row's description reaches the button; the button keeps its own
 * name (its label), so the row title is not put on it.
 */
export function RowAction({
  children,
  "aria-describedby": describedBy,
}: AriaProps & {
  children: ReactElement<AriaProps>;
}): JSX.Element {
  return (
    <div className="flex @xl/settings-row:justify-end">
      {cloneElement(children, {
        "aria-describedby": joinIds(children.props["aria-describedby"], describedBy),
      })}
    </div>
  );
}

/** Fills `{name}` placeholders of a translated template with React nodes (code spans). */
export { fillNodes } from "@/lib/i18n";
