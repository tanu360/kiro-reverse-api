import type { JSX } from "react";
import { PageHeader } from "@/components/shared/page-header";
import { useT } from "@/lib/i18n";

// Stub: the backups page task replaces this component and keeps the export name.
export function BackupsPage(): JSX.Element {
  const { t } = useT("backups");
  return <PageHeader title={t("title")} />;
}
