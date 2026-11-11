import { PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, type JSX, type ReactNode, useId } from "react";
import { PropertyRow } from "@/components/shared/property-list";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
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
 * One editable field of the sheet: a PropertyRow (label, saved value) with a pencil button at its
 * end, named "Edit" plus the label; the form lives in a small dialog with Cancel and Save, where
 * the field's hint sits under the control. The caller owns the draft (reset it in `onEdit`) and
 * closes the dialog once the save lands.
 */
export function EditableFieldRow({
  title,
  value,
  mono = false,
  open,
  onEdit,
  onOpenChange,
  onSubmit,
  saving,
  children,
}: {
  title: string;
  /** The saved value; empty shows a dash. */
  value: string;
  /** An ID or a URL: set in mono. */
  mono?: boolean;
  open: boolean;
  onEdit: () => void;
  onOpenChange: (open: boolean) => void;
  /** Called on Save (or Enter in a field) while no save is running. */
  onSubmit: () => void;
  saving: boolean;
  /** The dialog's form controls. */
  children: ReactNode;
}): JSX.Element {
  const { t } = useT();
  const editId = useId();
  const labelId = useId();
  const formId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!saving) onSubmit();
  };

  return (
    <>
      <PropertyRow
        action={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-labelledby={`${editId} ${labelId}`}
                  onClick={onEdit}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <HugeiconsIcon icon={PencilEdit01Icon} aria-hidden="true" />
              <span className="sr-only" id={editId}>
                {t("actions.edit")}
              </span>
            </TooltipTrigger>
            <TooltipPopup>{t("actions.edit")}</TooltipPopup>
          </Tooltip>
        }
        label={title}
        labelId={labelId}
        mono={mono}
        value={value}
      />
      <ResponsiveDialog
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} variant="ghost">
              {t("actions.cancel")}
            </Button>
            <Button form={formId} loading={saving} type="submit">
              {t("actions.save")}
            </Button>
          </>
        }
        onOpenChange={onOpenChange}
        open={open}
        size="md"
        title={title}
      >
        <form className="grid gap-4" id={formId} noValidate onSubmit={submit}>
          {children}
        </form>
      </ResponsiveDialog>
    </>
  );
}
