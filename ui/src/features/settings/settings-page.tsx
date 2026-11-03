import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { settingsQuery } from "@/lib/api/settings";
import { useT } from "@/lib/i18n";
import { AdminPasswordCard } from "./sections/admin-password-card";
import { AutoContinueCard } from "./sections/auto-continue-card";
import { DangerZoneCard } from "./sections/danger-zone-card";
import { EndpointCard } from "./sections/endpoint-card";
import { ModelMappingsCard } from "./sections/model-mappings-card";
import { OutboundProxyCard } from "./sections/outbound-proxy-card";
import { PromptFilterCard } from "./sections/prompt-filter-card";
import { RoutingCard } from "./sections/routing-card";
import { SETTINGS_SECTIONS } from "./sections/sections";
import { StreamIntegrityCard } from "./sections/stream-integrity-card";
import { ThinkingCard } from "./sections/thinking-card";
import { ToolHistoryCard } from "./sections/tool-history-card";
import { UsageCard } from "./sections/usage-card";

/** Read-only: no endpoint can change the listen address. */
function ListeningOn(): JSX.Element | null {
  const { t } = useT("settings");
  const { data } = useQuery(settingsQuery());
  if (!data?.port) return null;
  const host = data.host?.includes(":") ? `[${data.host}]` : data.host || "0.0.0.0";
  return (
    <Badge className="font-mono font-normal" variant="outline">
      {t("listeningOn", { address: `${host}:${data.port}` })}
    </Badge>
  );
}

/** Anchor links to every card: a sticky column on wide screens, a scrolling chip row below. */
function SectionNav(): JSX.Element {
  const { t } = useT("settings");
  return (
    <nav aria-label={t("sections")} className="min-w-0 lg:sticky lg:top-16 lg:self-start">
      <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:-mx-6 md:px-6 lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:p-0">
        {SETTINGS_SECTIONS.map((section) => (
          <li className="shrink-0" key={section.id}>
            <a
              className="inline-flex min-h-9 items-center whitespace-nowrap rounded-full border bg-background px-3 text-muted-foreground text-sm outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring lg:min-h-8 lg:w-full lg:rounded-md lg:border-transparent lg:bg-transparent lg:px-2"
              href={`#${section.id}`}
            >
              {t(section.titleKey)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function SettingsPage(): JSX.Element {
  const { t } = useT("settings");
  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-6">
      <PageHeader meta={<ListeningOn />} title={t("title")} />
      <div className="flex min-w-0 flex-col gap-4 lg:grid lg:grid-cols-[11rem_minmax(0,48rem)] lg:gap-8">
        <SectionNav />
        <div className="flex min-w-0 flex-col gap-4 md:gap-6">
          <UsageCard />
          <StreamIntegrityCard />
          <RoutingCard />
          <AutoContinueCard />
          <ToolHistoryCard />
          <ThinkingCard />
          <ModelMappingsCard />
          <EndpointCard />
          <AdminPasswordCard />
          <OutboundProxyCard />
          <PromptFilterCard />
          <DangerZoneCard />
        </div>
      </div>
    </div>
  );
}
