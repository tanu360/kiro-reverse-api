import { type FormEvent, type JSX, useId, useMemo, useRef, useState } from "react";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { batchAccounts } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
import type {
  Account,
  AccountActionResult,
  BatchEnableDisableResponse,
  BatchTagAction,
} from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDisplayEmail, useMaskText } from "@/lib/privacy";
import { toast } from "@/lib/toast";
import { MAX_TAG_LENGTH, MAX_TAGS, parseTagInput, tagKey } from "./account-metadata";
import { describeFailures } from "./account-model";
import { useInvalidateAccounts } from "./use-account-actions";

/** Every tag in the list once (ignoring case, first spelling), sorted, as quick picks. */
function tagsInUse(accounts: readonly Account[]): string[] {
  const byKey = new Map<string, string>();
  for (const account of accounts) {
    for (const tag of account.tags ?? []) {
      if (!byKey.has(tagKey(tag))) byKey.set(tagKey(tag), tag);
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Adds one tag to the selected accounts, or removes it from them. The field takes one tag (the
 * tags already in use are quick picks under it); Add is the form's submit, so Enter adds. The
 * result toast counts the accounts changed and names the ones that failed, such as an account
 * that already has the most tags.
 */
export function BatchTagDialog({
  open,
  onOpenChange,
  ids,
  accounts,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected account ids. */
  ids: string[];
  /** The whole list: the tags in use, and names for the result toast. */
  accounts: Account[];
  /** After a request lands: the page closes the dialog and clears the selection. */
  onDone: () => void;
}): JSX.Element {
  const { t } = useT("accounts");
  const formId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const invalidate = useInvalidateAccounts();
  const displayEmail = useDisplayEmail();
  const mask = useMaskText();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<BatchTagAction | null>(null);
  const inUse = useMemo(() => tagsInUse(accounts), [accounts]);

  const nameOf = (id: string) => {
    const account = accounts.find((item) => item.id === id);
    return account ? displayEmail(account.email, account.id) : id;
  };

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
    const toastId = toast.loading(t("batch.processing"));
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
      const failed = result.failed ?? 0;
      toast.update(toastId, {
        type: failed > 0 ? "warning" : "success",
        title: t(action === "addTag" ? "metadata.batchAddResult" : "metadata.batchRemoveResult", {
          count: result.count ?? 0,
        }),
        description: describeFailures(results, nameOf, t) || undefined,
      });
      setDraft("");
      onDone();
    } catch (failure) {
      toast.update(toastId, { type: "error", title: errorMessage(failure, t) });
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
      footer={
        <>
          <Button
            disabled={running === "addTag"}
            loading={running === "removeTag"}
            onClick={() => void run("removeTag")}
            variant="secondary"
          >
            {t("metadata.batchRemove")}
          </Button>
          <Button
            disabled={running === "removeTag"}
            form={formId}
            loading={running === "addTag"}
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
              setDraft(event.target.value);
              if (error) setError(null);
            }}
            ref={inputRef}
            spellCheck={false}
            value={draft}
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
                        setError(null);
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
      </form>
    </ResponsiveDialog>
  );
}
