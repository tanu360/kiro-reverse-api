import { useSearch } from "@tanstack/react-router";
import type { JSX } from "react";
import { useT } from "@/lib/i18n";
import { StubSignIn } from "./stub-sign-in";

// Stub: Task 12 replaces this page and keeps the export name.
export function LoginPage(): JSX.Element {
  const { t } = useT("auth");
  const { redirect } = useSearch({ from: "/login" });
  return <StubSignIn redirect={redirect} title={t("title")} />;
}
