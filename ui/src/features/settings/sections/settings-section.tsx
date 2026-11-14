import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type UseQueryResult, useMutation } from "@tanstack/react-query";
import {
  cloneElement,
  createContext,
  type FormEvent,
  type JSX,
  type ReactElement,
  type ReactNode,
  useContext,
} from "react";
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
import { errorMessage } from "@/lib/api/server-errors";
import { type TFunction, useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
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

/** "Could not save settings: {reason}"; error toasts stay until dismissed. */
export function toastSaveFailed(error: unknown, t: TFunction): string {
  return toast.error(t("settings:saveFailed", { reason: errorMessage(error, t) }));
}

/**
 * One card's save: success toasts "Settings saved" and calls `onSaved`; failure toasts the
 * reason and calls `onFailed`. The API client throws on any non-2xx, so `res.ok` is checked.
 */
export function useSectionSave<V>(
  save: (variables: V) => Promise<unknown>,
  handlers: {
    onSaved: (variables: V) => void;
    onFailed?: (error: unknown, variables: V) => void;
    successMessage?: string;
  },
): { save: (variables: V) => void; saving: boolean } {
  const { t } = useT("settings");
  const mutation = useMutation({
    mutationFn: save,
    onSuccess: (_data, variables) => {
      handlers.onSaved(variables);
      toast.success(handlers.successMessage ?? t("saved"));
    },
    onError: (error, variables) => {
      handlers.onFailed?.(error, variables);
      toastSaveFailed(error, t);
    },
  });
  return { save: mutation.mutate, saving: mutation.isPending };
}

/**
 * A hint of at most two sentences, with the rest behind the dotted "Learn more" (InfoHint's
 * link look) at its end.
 */
export function Hint({ children, more }: { children: ReactNode; more?: ReactNode }): JSX.Element {
  const { t } = useT("settings");
  if (!more) return <>{children}</>;
  return (
    <>
      {children}{" "}
      <InfoHint hint={more} variant="link">
        {t("learnMore")}
      </InfoHint>
    </>
  );
}

/** Save that also marks its card as unsaved in the section nav and the leave-page guard. */
function SaveButton({ dirty, saving }: { dirty: boolean; saving: boolean }): JSX.Element {
  useReportDirty(useContext(SectionIdContext), dirty);
  return <SharedSaveButton dirty={dirty} saving={saving} />;
}

/**
 * A card's footer: the shared save state ("Unsaved changes", or the server-changed notice in its
 * place), an optional note under it, and Save.
 */
export function SaveFooter({
  dirty,
  saving,
  serverChanged = false,
  onReload,
  note,
}: {
  dirty: boolean;
  saving: boolean;
  serverChanged?: boolean;
  onReload: () => void;
  note?: ReactNode;
}): JSX.Element {
  return (
    <SharedSaveFooter
      action={<SaveButton dirty={dirty} saving={saving} />}
      dirty={dirty}
      note={note}
      status={serverChanged ? <ServerChangedNotice onReload={onReload} /> : undefined}
    />
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
export function focusFirstInvalidField(form: HTMLFormElement): void {
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
 * Skeleton while the section's query loads, an error with Retry when it fails ("Could not load
 * {section} settings"), both under the section's heading. A section built on the shared GET
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
  if (query.isError && shared) {
    return <div hidden id={id} />;
  }
  if (query.isError) {
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
