import type { JSX } from "react";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { useT } from "@/lib/i18n";

export type AddAccountMethod =
  | "builderid"
  | "iam"
  | "microsoft"
  | "sso"
  | "local"
  | "credentials"
  | "cookie"
  | "apikey";

export interface AddAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMethod?: AddAccountMethod;
  onAdded?: (accountIds: string[]) => void;
}

// Stub: the add-account task replaces this dialog and keeps the exports.
export function AddAccountDialog({ open, onOpenChange }: AddAccountDialogProps): JSX.Element {
  const { t } = useT("add-account");
  return (
    <ResponsiveDialog onOpenChange={onOpenChange} open={open} title={t("title")}>
      {null}
    </ResponsiveDialog>
  );
}
