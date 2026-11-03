import type { JSX } from "react";
import { useT } from "@/lib/i18n";
import { StubSignIn } from "./stub-sign-in";

// Stub: Task 12 replaces this page and keeps the export name. It already signs in, because
// mock first-run is pending on every fresh load and unauthenticated visits land here.
export function SetupPage(): JSX.Element {
  const { t } = useT("auth");
  return <StubSignIn title={t("setupTitle")} />;
}
