import { KeyRoundIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";
import { CopyField } from "@/components/shared/code-field";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

/** Where a key holder signs in with their own key to see that key's usage (the /user page). */
export function userPanelUrl(): string {
  return `${window.location.origin}/user`;
}

/**
 * The full secret from the last create or regenerate. It lives only in the parent's state: never
 * stored or cached, and gone on the next create, on edit, on Dismiss and when the page unmounts.
 */
export function CreatedKeyPanel({
  apiKey,
  onDismiss,
  regenerated = false,
}: {
  apiKey: string;
  onDismiss: () => void;
  /** The secret replaced an existing key's value, so the old one no longer works. */
  regenerated?: boolean;
}): JSX.Element {
  const { t } = useT("api");
  return (
    <Alert data-testid="created-key-panel" variant="success">
      <HugeiconsIcon icon={KeyRoundIcon} aria-hidden="true" />
      <AlertTitle>{t("created.title")}</AlertTitle>
      <AlertDescription>
        <p>{regenerated ? t("created.regeneratedBody") : t("created.body")}</p>
        <CopyField
          copyLabel={t("created.copy")}
          label={t("created.title")}
          multiline
          value={apiKey}
        />
        <p>{t("created.userPanel")}</p>
        <CopyField
          copyLabel={t("created.copyUserPanel")}
          label={t("created.userPanelLabel")}
          multiline
          value={userPanelUrl()}
          variant="outline"
        />
      </AlertDescription>
      {/* Right of the text from sm, under it on phones: its edge lines up with the copy field. */}
      <AlertAction>
        <Button onClick={onDismiss} size="sm" variant="tone">
          {t("created.dismiss")}
        </Button>
      </AlertAction>
    </Alert>
  );
}
