import type { JSX } from "react";
import { PageHeader } from "@/components/shared/page-header";
import { useT } from "@/lib/i18n";

// Stub: the overview page task replaces this component and keeps the export name.
export function OverviewPage(): JSX.Element {
  const { t } = useT("overview");
  return <PageHeader title={t("title")} />;
}
