import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { duplicatesQuery } from "@/lib/api/duplicates";
import { useT } from "@/lib/i18n";
import { DuplicatesDialog } from "./duplicates-dialog";

/**
 * A warning above the accounts list while one Kiro user is stored more than once, with a Review
 * button that opens the merge dialog. Nothing shows without duplicates or when the check fails.
 */
export function DuplicatesNotice(): JSX.Element | null {
  const { t } = useT("accounts");
  const query = useQuery(duplicatesQuery());
  // Bumped on every open, so each review starts from the server's suggestions.
  const [dialog, setDialog] = useState({ open: false, session: 0 });
  const data = query.data;

  if (!data) return null;
  const count = data.duplicateCount;
  return (
    <>
      {count > 0 ? (
        <Alert role="status" variant="warning">
          <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
          <AlertTitle>{t("duplicates.notice", { count })}</AlertTitle>
          <AlertDescription>{t("duplicates.noticeDescription")}</AlertDescription>
          <AlertAction>
            <Button
              onClick={() => setDialog((current) => ({ open: true, session: current.session + 1 }))}
              size="sm"
              variant="tone"
            >
              {t("duplicates.review")}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      <DuplicatesDialog
        groups={data.groups}
        key={dialog.session}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        open={dialog.open}
      />
    </>
  );
}
