import { KeyRoundIcon } from "lucide-react";
import type { JSX } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

/**
 * The full secret from the last create. It lives only in the parent's state: never stored or
 * cached, and gone on the next create, on edit, on Dismiss and when the page unmounts.
 */
export function CreatedKeyPanel({
  apiKey,
  onDismiss,
}: {
  apiKey: string;
  onDismiss: () => void;
}): JSX.Element {
  const { t } = useT("api");
  return (
    <Alert className="mb-4" data-testid="created-key-panel" variant="success">
      <KeyRoundIcon aria-hidden="true" />
      <AlertTitle>{t("created.title")}</AlertTitle>
      <AlertDescription>
        <p>{t("created.body")}</p>
        <div className="flex min-w-0 items-center gap-1 rounded-lg border bg-background py-1 ps-3 pe-1">
          <code className="min-w-0 flex-1 break-all font-mono text-foreground text-xs">
            {apiKey}
          </code>
          <CopyButton label={t("created.copy")} value={apiKey} />
        </div>
        <div>
          <Button onClick={onDismiss} size="sm" variant="outline">
            {t("created.dismiss")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
