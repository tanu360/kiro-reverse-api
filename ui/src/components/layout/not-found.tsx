import { ArrowLeft01Icon, LayoutDashboardIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useRouter } from "@tanstack/react-router";
import type { JSX } from "react";
import { AnimatedIcon } from "@/components/shared/animated-icon";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { StatusPage } from "./status-page";

/** Any address no route matches. "Go back" only appears when this tab has a page to go back to. */
export function NotFound(): JSX.Element {
  const { t } = useT();
  const router = useRouter();
  const canGoBack = router.history.canGoBack();

  return (
    <StatusPage
      description={t("shell.notFound.description")}
      eyebrow={t("shell.errorCode", { code: 404 })}
      title={t("shell.notFound.title")}
    >
      <Button className="w-full" render={<Link to="/" />} size="lg">
        <AnimatedIcon icon={LayoutDashboardIcon} aria-hidden="true" />
        {t("shell.notFound.action")}
      </Button>
      {canGoBack ? (
        <Button
          className="w-full"
          onClick={() => router.history.back()}
          size="lg"
          variant="outline"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} aria-hidden="true" />
          {t("shell.notFound.back")}
        </Button>
      ) : null}
    </StatusPage>
  );
}
