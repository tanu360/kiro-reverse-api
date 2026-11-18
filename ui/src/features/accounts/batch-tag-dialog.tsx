import {
  type ComponentProps,
  type FormEvent,
  type JSX,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActionError } from "@/components/shared/action-error";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { announce } from "@/lib/announce";
import { batchAccounts } from "@/lib/api/accounts";
import type {
  Account,
  AccountActionResult,
  BatchEnableDisableResponse,
  BatchTagAction,
} from "@/lib/api/types";
import { compareText } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import {
  editMaskedText,
  type FieldSelection,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  parseTagInput,
  tagKey,
} from "./account-metadata";
import { describeFailures } from "./account-model";
import { failedIdsIn, useAccountNameOf } from "./batch-bar";
import { useInvalidateAccounts } from "./use-account-actions";

/** Every tag in the list once (ignoring case, first spelling), sorted, as quick picks. */
function tagsInUse(accounts: readonly Account[]): string[] {
  const byKey = new Map<string, string>();
  for (const account of accounts) {
    for (const tag of account.tags ?? []) {
      if (!byKey.has(tagKey(tag))) byKey.set(tagKey(tag), tag);
    }
  }
  return [...byKey.values()].sort((a, b) => compareText(a, b));
}

/**
 * Adds one tag to the selected accounts, or removes it from them. The field takes one tag (the
 * tags already in use are quick picks under it); Add is the form's submit, so Enter adds. The
 * pressed button spins; a clean run closes the dialog (a screen reader hears how many
 * accounts changed). A partial run stays open on the failed accounts, counting the changed ones
 * and naming the failed ones (such as an account that already has the most tags), where Try
 * again runs on those; a failed request says why, also with Try again.
 */
export function BatchTagDialog({
  open,
  onOpenChange,
  ids,
  accounts,
  onDone,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected account ids. */
  ids: string[];
  /** The whole list: the tags in use, and names for the failed accounts. */
  accounts: Account[];
  /**
   * After a request lands. Nothing failed: the page closes the dialog and clears the selection.
   * Else the failed ids still in the list: the page keeps the dialog on them and selects them.
   */
  onDone: (failedIds: string[]) => void;
  /** Where focus goes on close; the opener is gone once `onDone` clears the selection. */
  finalFocus?: ComponentProps<typeof ResponsiveDialog>["finalFocus"];
}): JSX.Element {
  const { t } = useT("accounts");
  const formId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The field's selection just before an edit: it tells a replaced masked pick from an edit of it.
  const selectionBeforeEdit = useRef<FieldSelection | null>(null);
  const fieldRef = useCallback((node: HTMLInputElement | null) => {
    inputRef.current = node;
    if (!node) return;
    const note = () => {
      selectionBeforeEdit.current = {
        start: node.selectionStart ?? node.value.length,
        end: node.selectionEnd ?? node.value.length,
      };
    };
    node.addEventListener("beforeinput", note);
    return () => {
      node.removeEventListener("beforeinput", note);
      inputRef.current = null;
    };
  }, []);
  const { t: tc } = useT();
  const invalidate = useInvalidateAccounts();
  const nameOf = useAccountNameOf(accounts);
  const mask = useMaskText();
  const [draft, setDraft] = useState("");
  // The quick pick in the field: shown masked under privacy (as the chips are) while untouched.
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<BatchTagAction | null>(null);
  // The last run that failed (wholly or for some accounts), said in the dialog.
  const [failure, setFailure] = useState<{
    action: BatchTagAction;
    error: unknown;
    message?: string;
  } | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const removeRef = useRef<HTMLButtonElement | null>(null);
  // Every opening starts with an empty field: a draft or error left by Escape does not come back.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft("");
      setPicked(null);
      setError(null);
      setFailure(null);
    }
  }
  const inUse = useMemo(() => tagsInUse(accounts), [accounts]);
  const shown = picked !== null && draft === picked ? mask(picked) : draft;

  /** The one tag typed, or null after showing why it cannot be sent. */
  const readTag = (): string | null => {
    const parsed = parseTagInput(draft);
    let message: string | null = null;
    if (parsed.error?.kind === "tooLong") {
      message = t("metadata.tagTooLong", { tag: parsed.error.tag, length: MAX_TAG_LENGTH });
    } else if (parsed.tags.length === 0) {
      message = t("metadata.batchTagRequired");
    } else if (parsed.tags.length > 1) {
      message = t("metadata.batchOneTag");
    }
    setError(message);
    if (message) {
      inputRef.current?.focus();
      return null;
    }
    return parsed.tags[0] ?? null;
  };

  const run = async (action: BatchTagAction) => {
    if (running) return;
    const tag = readTag();
    if (tag === null) return;
    setRunning(action);
    setFailure(null);
    try {
      const result = (await batchAccounts({
        ids: [...ids],
        action,
        tag,
      })) as BatchEnableDisableResponse;
      // A full account fails without a server code; its reason is said here.
      const results: AccountActionResult[] = (result.results ?? []).map((row) =>
        row.status === "tag_limit"
          ? { ...row, error: t("metadata.tagLimit", { max: MAX_TAGS }) }
          : row,
      );
      const title = t(
        action === "addTag" ? "metadata.batchAddResult" : "metadata.batchRemoveResult",
        { count: result.count ?? 0 },
      );
      const details = describeFailures(results, nameOf, t);
      const message = details ? tc("text.joinSentences", { first: title, second: details }) : title;
      // Failed accounts still in the list stay in the dialog, with the draft, so Try again sends
      // the same tag to them. Accounts gone from the list leave nothing to try again.
      const again = (result.failed ?? 0) > 0 ? failedIdsIn(result.results, accounts) : [];
      if (again.length > 0) {
        setFailure({ action, error: null, message });
        onDone(again);
      } else {
        announce(message);
        setDraft("");
        setPicked(null);
        onDone([]);
      }
    } catch (failed) {
      setFailure({ action, error: failed });
    } finally {
      setRunning(null);
      await invalidate();
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void run("addTag");
  };

  return (
    <ResponsiveDialog
      description={t("metadata.batchTagsDescription")}
      dismissible={running === null}
      finalFocus={finalFocus}
      footer={
        <>
          <Button
            disabled={running === "addTag"}
            loading={running === "removeTag"}
            onClick={() => void run("removeTag")}
            ref={removeRef}
            variant="secondary"
          >
            {t("metadata.batchRemove")}
          </Button>
          <Button
            disabled={running === "removeTag"}
            form={formId}
            loading={running === "addTag"}
            ref={addRef}
            type="submit"
          >
            {t("metadata.batchAdd")}
          </Button>
        </>
      }
      initialFocus={inputRef}
      onOpenChange={onOpenChange}
      open={open}
      size="md"
      title={t("metadata.batchTagsTitle", { count: ids.length })}
    >
      <form className="flex flex-col gap-4" id={formId} noValidate onSubmit={onSubmit}>
        <Field invalid={error !== null}>
          <FieldLabel>{t("metadata.batchTagInput")}</FieldLabel>
          <Input
            autoComplete="off"
            onChange={(event) => {
              const next = event.target.value;
              // An edit of a masked pick lands on the tag itself: the masked text is never a tag.
              setDraft(
                shown === draft
                  ? next
                  : editMaskedText(draft, shown, next, selectionBeforeEdit.current),
              );
              selectionBeforeEdit.current = null;
              setPicked(null);
              if (error) setError(null);
              // The notice names the tag it ran with; Try again would send the new one.
              setFailure(null);
            }}
            ref={fieldRef}
            spellCheck={false}
            value={shown}
          />
          {error ? <FieldError match>{error}</FieldError> : null}
        </Field>
        {inUse.length > 0 ? (
          <fieldset>
            <legend className="mb-2 text-muted-foreground text-xs">
              {t("metadata.batchExisting")}
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {inUse.map((tag) => (
                <Badge
                  key={tag}
                  render={
                    <button
                      onClick={() => {
                        setDraft(tag);
                        setPicked(tag);
                        setError(null);
                        setFailure(null);
                        inputRef.current?.focus();
                      }}
                      type="button"
                    />
                  }
                  size="sm"
                  tone="neutral"
                >
                  <span className="max-w-24 truncate">{mask(tag)}</span>
                </Badge>
              ))}
            </div>
          </fieldset>
        ) : null}
        {failure ? (
          <ActionError
            error={failure.error}
            message={failure.message}
            onDismiss={() => {
              (failure.action === "addTag" ? addRef : removeRef).current?.focus();
              setFailure(null);
            }}
            onRetry={() => {
              (failure.action === "addTag" ? addRef : removeRef).current?.focus();
              void run(failure.action);
            }}
          />
        ) : null}
      </form>
    </ResponsiveDialog>
  );
}
