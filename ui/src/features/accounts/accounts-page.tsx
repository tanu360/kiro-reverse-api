import type { JSX } from "react";
import { PageHeader } from "@/components/shared/page-header";
import { useT } from "@/lib/i18n";

// Stub: the accounts page task replaces this component and keeps the export name.
export function AccountsPage(): JSX.Element {
  const { t } = useT("accounts");
  return <PageHeader title={t("title")} />;
}
