import { useMutation } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { InlineEditRow } from "@/components/shared/property-list";
import { updateAccount } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
import type { UpdateAccountRequest } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { useInvalidateAccounts } from "../use-account-actions";

/**
 * PUT one field of an account, toast "Saved" and refetch the list. Each editor owns its own
 * draft, so the refetch never wipes unsaved input elsewhere in the sheet.
 */
export function useSaveAccountField(accountId: string) {
  const { t } = useT("accounts");
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (patch: UpdateAccountRequest) => updateAccount(accountId, patch),
    onSuccess: () => {
      toast.success(t("detail.saved"));
      return invalidate();
    },
    onError: (error) => {
      toast.error(t("detail.saveFailed", { reason: errorMessage(error, t) }));
    },
  });
}

/**
 * One editable field of the sheet, edited in place (InlineEditRow): the label and saved value,
 * the whole row a button that swaps the value for the field's controls with Save and Cancel at
 * their end. The field's hint and error sit under its control. The caller owns the draft (reset
 * it in `onEdit`) and closes the edit once the save lands.
 */
export function EditableFieldRow({
  title,
  value,
  mono = false,
  wide = false,
  open,
  onEdit,
  onOpenChange,
  onSubmit,
  saving,
  children,
}: {
  title: string;
  /** The saved value (text, or a node such as the proxy's inherited value); empty shows a dash. */
  value: ReactNode;
  /** An ID or a URL: set in mono. */
  mono?: boolean;
  /** The edit view gives its controls the whole row (InlineEditRow `wide`). */
  wide?: boolean;
  /** The edit view is showing. */
  open: boolean;
  onEdit: () => void;
  onOpenChange: (open: boolean) => void;
  /** Called on Save (or Enter in a field) while no save is running. */
  onSubmit: () => void;
  saving: boolean;
  /** The edit view's form controls. */
  children: ReactNode;
}): JSX.Element {
  return (
    <InlineEditRow
      editing={open}
      label={title}
      mono={mono}
      onCancel={() => onOpenChange(false)}
      onEdit={onEdit}
      onSubmit={onSubmit}
      saving={saving}
      value={value}
      wide={wide}
    >
      {children}
    </InlineEditRow>
  );
}
