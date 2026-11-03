import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ChartColumnIcon,
  CodeIcon,
  GlobeIcon,
  KeyRoundIcon,
  LayersIcon,
  type LucideIcon,
  MessageSquareIcon,
  WandSparklesIcon,
  ZapIcon,
} from "lucide-react";
import type { JSX } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { SectionCard } from "@/components/shared/section-card";
import { Badge } from "@/components/ui/badge";
import { settingsQuery } from "@/lib/api/settings";
import { useT } from "@/lib/i18n";
import { CodeText } from "./code-text";

interface Endpoint {
  id: string;
  icon: LucideIcon;
  titleKey: string;
  copyKey: string;
  method: "POST" | "GET";
  path: string;
}

/** The public endpoints the old API tab listed (handler.go router). */
const ENDPOINTS: readonly Endpoint[] = [
  {
    id: "claude",
    icon: MessageSquareIcon,
    titleKey: "endpoints.claude",
    copyKey: "endpoints.copyClaude",
    method: "POST",
    path: "/v1/messages",
  },
  {
    id: "openai",
    icon: WandSparklesIcon,
    titleKey: "endpoints.openai",
    copyKey: "endpoints.copyOpenAI",
    method: "POST",
    path: "/v1/chat/completions",
  },
  {
    id: "responses",
    icon: ZapIcon,
    titleKey: "endpoints.responses",
    copyKey: "endpoints.copyResponses",
    method: "POST",
    path: "/v1/responses",
  },
  {
    id: "models",
    icon: LayersIcon,
    titleKey: "endpoints.modelList",
    copyKey: "endpoints.copyModels",
    method: "GET",
    path: "/v1/models",
  },
  {
    id: "codex-models",
    icon: CodeIcon,
    titleKey: "endpoints.codexModelManifest",
    copyKey: "endpoints.copyCodexModels",
    method: "GET",
    path: "/v1/codex/models",
  },
  {
    id: "stats",
    icon: ChartColumnIcon,
    titleKey: "endpoints.stats",
    copyKey: "endpoints.copyStats",
    method: "GET",
    path: "/v1/stats",
  },
];

/** "http://host:port/v1/x" with protocol, host and path tinted apart. */
function EndpointUrl({ origin, path }: { origin: string; path: string }): JSX.Element {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i.exec(origin);
  const protocol = match?.[1] ?? "";
  const host = match?.[2] ?? origin;
  return (
    <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed">
      <span className="text-muted-foreground">{protocol}</span>
      <span className="text-foreground">{host}</span>
      <span className="text-info-foreground">{path}</span>
    </code>
  );
}

export function EndpointsCard(): JSX.Element {
  const { t } = useT("api");
  const settings = useQuery(settingsQuery());
  const origin = window.location.origin;
  const required = settings.data?.requireApiKey ?? false;

  return (
    <SectionCard
      actions={
        <Badge icon={GlobeIcon} iconStyle="line" variant="outline">
          {t("endpoints.protocolHttp")}
        </Badge>
      }
      description={t("endpoints.description")}
      footer={
        <p className="flex items-start gap-2 text-muted-foreground text-sm">
          <KeyRoundIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span data-testid="endpoints-auth-hint">
            <CodeText
              code={{ bearer: "Authorization: Bearer <key>", xApiKey: "X-Api-Key: <key>" }}
              text={required ? t("endpoints.authRequired") : t("endpoints.authOptional")}
            />
          </span>
        </p>
      }
      id="api-endpoints"
      title={t("endpoints.title")}
    >
      <ul aria-label={t("endpoints.title")} className="flex flex-col divide-y">
        {ENDPOINTS.map((endpoint) => {
          const Icon = endpoint.icon;
          const url = origin + endpoint.path;
          return (
            <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" key={endpoint.id}>
              <div className="flex items-center gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
                  <Icon aria-hidden="true" className="size-3.5" />
                </span>
                <span className="min-w-0 truncate font-medium text-sm">{t(endpoint.titleKey)}</span>
                <Badge
                  className="ms-auto font-mono"
                  icon={endpoint.method === "POST" ? ArrowUpRightIcon : ArrowDownLeftIcon}
                  iconStyle="line"
                  tone={endpoint.method === "POST" ? "primary" : "success"}
                  variant="soft-outline"
                >
                  {endpoint.method === "POST"
                    ? t("endpoints.methodPost")
                    : t("endpoints.methodGet")}
                </Badge>
              </div>
              <div
                className="flex min-w-0 items-center gap-1 rounded-lg border bg-muted/40 py-1 ps-3 pe-1"
                data-endpoint={endpoint.id}
              >
                <EndpointUrl origin={origin} path={endpoint.path} />
                <CopyButton label={t(endpoint.copyKey)} value={url} />
              </div>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
