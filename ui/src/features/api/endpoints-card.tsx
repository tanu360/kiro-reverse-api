import {
  ChartColumnIcon,
  CodeIcon,
  Globe02Icon,
  KeyRoundIcon,
  Layers01Icon,
  MessageSquareIcon,
  WandSparklesIcon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { CopyField } from "@/components/shared/code-field";
import { IconChip } from "@/components/shared/icon-chip";
import { SectionCard } from "@/components/shared/section-card";
import { SettingsRowTitle } from "@/components/shared/settings-rows";
import { Badge } from "@/components/ui/badge";
import { settingsQuery } from "@/lib/api/settings";
import { useT } from "@/lib/i18n";
import { CodeText } from "./code-text";

interface Endpoint {
  id: string;
  icon: IconSvgElement;
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
    icon: Layers01Icon,
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

export function EndpointsCard(): JSX.Element {
  const { t } = useT("api");
  const settings = useQuery(settingsQuery());
  const origin = window.location.origin;
  const required = settings.data?.requireApiKey ?? false;

  return (
    <SectionCard
      description={t("endpoints.description")}
      footer={
        <p className="flex items-start gap-2">
          <HugeiconsIcon
            icon={KeyRoundIcon}
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span data-testid="endpoints-auth-hint">
            <CodeText
              code={{ bearer: "Authorization: Bearer <key>", xApiKey: "X-Api-Key: <key>" }}
              text={required ? t("endpoints.authRequired") : t("endpoints.authOptional")}
            />
          </span>
        </p>
      }
      icon={Globe02Icon}
      id="api-endpoints"
      meta={t("endpoints.protocolHttp")}
      title={t("endpoints.title")}
    >
      <ul aria-label={t("endpoints.title")} className="flex flex-col gap-3">
        {ENDPOINTS.map((endpoint) => {
          const title = t(endpoint.titleKey);
          const post = endpoint.method === "POST";
          return (
            <li
              className="flex min-w-0 flex-col gap-2 @3xl:flex-row @3xl:items-center @3xl:gap-3"
              data-endpoint={endpoint.id}
              key={endpoint.id}
            >
              <div className="flex min-w-0 items-center gap-2 @3xl:w-60 @3xl:shrink-0">
                <IconChip icon={endpoint.icon} />
                <span className="min-w-0 truncate">
                  <SettingsRowTitle>{title}</SettingsRowTitle>
                </span>
                <Badge className="ms-auto" size="sm" tone={post ? "primary" : "neutral"}>
                  {post ? t("endpoints.methodPost") : t("endpoints.methodGet")}
                </Badge>
              </div>
              {/* Under the title until the card has room for both, so a URL rarely needs to wrap. */}
              <CopyField
                className="min-w-0 @3xl:flex-1"
                copyLabel={t(endpoint.copyKey)}
                label={title}
                multiline
                value={origin + endpoint.path}
              />
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
