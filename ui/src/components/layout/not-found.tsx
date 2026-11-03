import { Link } from "@tanstack/react-router";
import { CompassIcon } from "lucide-react";
import type { JSX } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useT } from "@/lib/i18n";

export function NotFound(): JSX.Element {
  const { t } = useT();
  useDocumentTitle(t("shell.notFound.title"));
  return (
    <main className="flex min-h-svh items-center justify-center p-4" id="main">
      <EmptyState
        action={<Button render={<Link to="/" />}>{t("shell.notFound.action")}</Button>}
        description={t("shell.notFound.description")}
        icon={CompassIcon}
        title={t("shell.notFound.title")}
      />
    </main>
  );
}
