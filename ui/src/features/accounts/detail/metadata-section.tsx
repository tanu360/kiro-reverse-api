import { type JSX, useState } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Account } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";
import { MAX_NOTES, MAX_TAG_LENGTH, MAX_TAGS, parseTagInput } from "../account-metadata";
import { TagBadges } from "../account-tags";
import { EditableFieldRow, useSaveAccountField } from "./detail-section";

/**
 * The operator's notes. The row reads one line (emails masked under privacy); the edit view is a
 * growing text area over the whole row, where Enter adds a line and Save stores it. The edit
 * holds the raw text: editing masked text would save the mask.
 */
export function NotesRow({ account }: { account: Account }): JSX.Element {
  const { t, lang } = useT("accounts");
  const mask = useMaskText();
  const save = useSaveAccountField(account.id);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(account.notes ?? "");

  return (
    <EditableFieldRow
      onEdit={() => {
        setDraft(account.notes ?? "");
        setOpen(true);
      }}
      onOpenChange={setOpen}
      onSubmit={() => save.mutate({ notes: draft.trim() }, { onSuccess: () => setOpen(false) })}
      open={open}
      saving={save.isPending}
      multiline
      title={t("metadata.notes")}
      value={mask(account.notes)}
      wide
    >
      <Field>
        <FieldLabel className="sr-only">{t("metadata.notes")}</FieldLabel>
        <Textarea
          maxLength={MAX_NOTES}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t("metadata.notesPlaceholder")}
          value={draft}
        />
        <FieldDescription>
          {t("metadata.notesHint", {
            length: formatNumber(draft.length, lang),
            max: formatNumber(MAX_NOTES, lang),
          })}
        </FieldDescription>
      </Field>
    </EditableFieldRow>
  );
}

/**
 * The account's tags, typed comma-separated. The row shows them as pills; Save refuses more than
 * MAX_TAGS tags or one longer than MAX_TAG_LENGTH instead of letting the server cut them.
 */
export function TagsRow({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const save = useSaveAccountField(account.id);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const tags = account.tags ?? [];

  const onSubmit = () => {
    const parsed = parseTagInput(draft);
    if (parsed.error) {
      setError(
        parsed.error.kind === "tooMany"
          ? t("metadata.tagsTooMany", { max: MAX_TAGS })
          : t("metadata.tagTooLong", { tag: parsed.error.tag, length: MAX_TAG_LENGTH }),
      );
      return;
    }
    setError(null);
    save.mutate({ tags: parsed.tags }, { onSuccess: () => setOpen(false) });
  };

  return (
    <EditableFieldRow
      onEdit={() => {
        setDraft(tags.join(", "));
        setError(null);
        setOpen(true);
      }}
      onOpenChange={setOpen}
      onSubmit={onSubmit}
      open={open}
      saving={save.isPending}
      title={t("metadata.tags")}
      value={tags.length > 0 ? <TagBadges max={MAX_TAGS} tags={tags} wrap /> : ""}
      wide
    >
      <Field invalid={error !== null}>
        <FieldLabel className="sr-only">{t("metadata.tags")}</FieldLabel>
        <Input
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          placeholder={t("metadata.tagsPlaceholder")}
          spellCheck={false}
          value={draft}
        />
        {error ? <FieldError match>{error}</FieldError> : null}
        <FieldDescription>
          {t("metadata.tagsHint", { max: MAX_TAGS, length: MAX_TAG_LENGTH })}
        </FieldDescription>
      </Field>
    </EditableFieldRow>
  );
}
