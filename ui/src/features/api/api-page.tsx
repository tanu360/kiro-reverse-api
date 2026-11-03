import type { JSX } from "react";
import { PageHeader } from "@/components/shared/page-header";
import { useT } from "@/lib/i18n";
import { ApiAccessCard } from "./api-access-card";
import { ApiKeysCard } from "./api-keys-card";
import { ClientSnippetsCard } from "./client-snippets";
import { EndpointsCard } from "./endpoints-card";

/** /admin/api: API access, API keys, endpoint URLs and client setup snippets. */
export function ApiPage(): JSX.Element {
  const { t } = useT("api");
  return (
    <>
      <PageHeader description={t("description")} title={t("title")} />
      <ApiAccessCard />
      <ApiKeysCard />
      <div className="grid min-w-0 grid-cols-1 gap-4 md:gap-6 xl:grid-cols-2 xl:items-start">
        <EndpointsCard />
        <ClientSnippetsCard />
      </div>
    </>
  );
}
