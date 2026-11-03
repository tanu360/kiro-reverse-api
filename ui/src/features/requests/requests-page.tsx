import type { JSX } from "react";
import { PageHeader } from "@/components/shared/page-header";
import { useT } from "@/lib/i18n";

// Stub: the requests page task replaces this component and keeps the export name.
export function RequestsPage(): JSX.Element {
  const { t } = useT("requests");
  return <PageHeader title={t("title")} />;
}
