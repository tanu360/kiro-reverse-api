import { PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, type JSX, type ReactNode, useId } from "react";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { ROW_DESCRIPTION, SettingsRow } from "@/components/shared/settings-rows";
import { Button } from "@/components/ui/button";
import { updateAccount } from "@/lib/api/accounts";
import { errorMessage } from "@/lib/api/server-errors";
import type { UpdateAccountRequest } from "@/lib/api/types";
import { EMPTY } from "@/lib/format";
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

/** The saved value under a row's title: muted text, set in mono for an ID or a URL. */
function FieldValue({ value, mono }: { value: string; mono: boolean }): JSX.Element {
  if (mono && value !== "") {
    return (
      <span className="block min-w-0 truncate font-mono text-meta text-muted-foreground">
        {value}
      </span>
    );
  }
  return (
    <span className="block min-w-0 truncate text-muted-foreground text-sm tabular-nums">
      {value === "" ? EMPTY : value}
    </span>
  );
}

/**
 * One editable field of the sheet, in the Settings row-and-dialog pattern: the row shows the
 * title, the saved value and a hint, with an Edit button at its end; the form lives in a small
 * dialog with Cancel and Save. The caller owns the draft (reset it in `onEdit`) and closes the
 * dialog once the save lands.
 */
export function EditableFieldRow({
  title,
  value,
  mono = false,
  hint,
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
  hint?: ReactNode;
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
  const formId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!saving) onSubmit();
  };

  return (
    <>
      <SettingsRow
        control={
          // Named "Edit" plus the row title (SettingsRow appends it to aria-labelledby).
          <Button aria-labelledby={editId} id={editId} onClick={onEdit} size="sm" variant="outline">
            <HugeiconsIcon icon={PencilEdit01Icon} aria-hidden="true" />
            {t("actions.edit")}
          </Button>
        }
        controlWidth="auto"
        labelControl
        title={title}
      >
        <FieldValue mono={mono} value={value} />
        {hint ? <p className={ROW_DESCRIPTION}>{hint}</p> : null}
      </SettingsRow>
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
