import { useMutation } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { ActionError } from "@/components/shared/action-error";
import { InlineEditRow } from "@/components/shared/property-list";
import { announce } from "@/lib/announce";
import { updateAccount } from "@/lib/api/accounts";
import type { UpdateAccountRequest } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useInvalidateAccounts } from "../use-account-actions";

/**
 * PUT one field of an account and refetch the list. Each editor owns its own draft, so the
 * refetch never wipes unsaved input elsewhere in the sheet. The edit closes on the
 * saved value (a screen reader hears "saved"), and a failure stays under the field
 * (EditableFieldRow), where Save is the retry.
 */
export function useSaveAccountField(accountId: string) {
  const { t } = useT("accounts");
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (patch: UpdateAccountRequest) => updateAccount(accountId, patch),
    onSuccess: () => {
      announce(t("detail.saved"));
      return invalidate();
    },
  });
}

/** What EditableFieldRow reads of the field's save (useSaveAccountField). */
interface FieldSave {
  isPending: boolean;
  error: Error | null;
  reset: () => void;
}

/**
 * One editable field of the sheet, edited in place (InlineEditRow): the label and saved value,
 * the whole row a button that swaps the value for the field's controls with Save and Cancel at
 * their end. The field's hint and error sit under its control, and a failed save under them. The
 * caller owns the draft (reset it in `onEdit`) and closes the edit once the save lands.
 */
export function EditableFieldRow({
  title,
  value,
  mono = false,
  multiline = false,
  wide = false,
  open,
  onEdit,
  onOpenChange,
  onSubmit,
  save,
  extraError,
  children,
}: {
  title: string;
  /** The saved value (text, or a node such as the proxy's inherited value); empty shows a dash. */
  value: ReactNode;
  /** An ID or a URL: set in mono. */
  mono?: boolean;
  /** Free text: the read view keeps line breaks (InlineEditRow `multiline`). */
  multiline?: boolean;
  /** The edit view gives its controls the whole row (InlineEditRow `wide`). */
  wide?: boolean;
  /** The edit view is showing. */
  open: boolean;
  onEdit: () => void;
  onOpenChange: (open: boolean) => void;
  /** Called on Save (or Enter in a field) while no save is running. */
  onSubmit: () => void;
  /** The field's save: Save spins while it runs, and its failure shows under the controls. */
  save: FieldSave;
  /** Another failed request of the edit's own (the machine ID's dice), shown the same way. */
  extraError?: unknown;
  /** The edit view's form controls. */
  children: ReactNode;
}): JSX.Element {
  // A failure belongs to the edit it came from: a new edit or Cancel starts without it.
  const failure = save.error ?? extraError ?? null;
  return (
    <InlineEditRow
      editing={open}
      label={title}
      mono={mono}
      multiline={multiline}
      onCancel={() => {
        save.reset();
        onOpenChange(false);
      }}
      onEdit={() => {
        save.reset();
        onEdit();
      }}
      onSubmit={onSubmit}
      saving={save.isPending}
      value={value}
      wide={wide}
    >
      {children}
      {failure ? <ActionError className="mt-1.5" error={failure} /> : null}
    </InlineEditRow>
  );
}
