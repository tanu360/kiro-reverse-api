import { useSearch } from "@tanstack/react-router";
import type { JSX } from "react";
import { useT } from "@/lib/i18n";
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
    </AuthLayout>
  );
}
