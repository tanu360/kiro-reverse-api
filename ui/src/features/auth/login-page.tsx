import { Link, useSearch } from "@tanstack/react-router";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { fillNodes, useT } from "@/lib/i18n";
import { AuthHeader, AuthLayout } from "./auth-layout";
import { SignInForm } from "./sign-in-form";

/** /login. A pending first run never shows here: its route sends the visit to /setup. */
export function LoginPage(): JSX.Element {
  const { t } = useT("auth");
  const { redirect } = useSearch({ from: "/login" });

  return (
    <AuthLayout>
      <AuthHeader description={t("subtitle")} title={t("title")} />
      <SignInForm redirect={redirect} />
      {/* An API key holder signs in on /user/login instead, to see that key's usage. */}
      <p className="text-center text-muted-foreground text-sm">
        {fillNodes(t("apiKeyPrompt"), {
          link: (
            <Button render={<Link to="/user/login" />} variant="link-inline">
              {t("apiKeyLink")}
            </Button>
          ),
        })}
      </p>
    </AuthLayout>
  );
}
