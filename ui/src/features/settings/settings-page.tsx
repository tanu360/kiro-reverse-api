import type { JSX } from "react";
import { PageHeader } from "@/components/shared/page-header";
import { useT } from "@/lib/i18n";

// Stub: the settings page task replaces this component and keeps the export name.
export function SettingsPage(): JSX.Element {
  const { t } = useT("settings");
  return <PageHeader title={t("title")} />;
}
