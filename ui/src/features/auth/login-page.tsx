import { useSearch } from "@tanstack/react-router";
import type { JSX } from "react";
import { useT } from "@/lib/i18n";
import { AuthHeader, AuthLayout, AuthSwitchLink } from "./auth-layout";
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
      <AuthSwitchLink label={t("apiKeyLink")} prompt={t("apiKeyPrompt")} to="/user/login" />
    </AuthLayout>
  );
}
