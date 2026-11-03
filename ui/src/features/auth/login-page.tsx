import { useSearch } from "@tanstack/react-router";
import type { JSX } from "react";
import { CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { useT } from "@/lib/i18n";
import { AuthLayout } from "./auth-layout";
import { SignInForm } from "./sign-in-form";

/** /login. A pending first run never shows here: its route sends the visit to /setup. */
export function LoginPage(): JSX.Element {
  const { t } = useT("auth");
  const { redirect } = useSearch({ from: "/login" });

  return (
    <AuthLayout>
      <CardHeader>
        <CardTitle render={(props) => <h1 {...props} />}>{t("title")}</CardTitle>
        <CardDescription>{t("subtitle")}</CardDescription>
      </CardHeader>
      <CardPanel>
        <SignInForm redirect={redirect} />
      </CardPanel>
    </AuthLayout>
  );
}
