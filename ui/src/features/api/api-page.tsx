import type { JSX } from "react";
import { PageHeader } from "@/components/shared/page-header";
import { useT } from "@/lib/i18n";

// Stub: the api page task replaces this component and keeps the export name.
export function ApiPage(): JSX.Element {
  const { t } = useT("api");
  return <PageHeader title={t("title")} />;
}
