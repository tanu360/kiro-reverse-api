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
import { CopyButton } from "@/components/shared/copy-button";
import { IconChip } from "@/components/shared/icon-chip";
import { SectionCard } from "@/components/shared/section-card";
import { SETTINGS_ROW_X, SettingsRowTitle } from "@/components/shared/settings-rows";
import { Badge } from "@/components/ui/badge";
import { settingsQuery } from "@/lib/api/settings";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
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

/**
 * The endpoints as a flush list, one row each under a hairline: the icon chip, the name with
 * its URL under it (mono; the host muted, the path in the text colour, so the paths scan down
 * the list), then the method and a copy button at the row's end. Plain text, no field boxes.
 * Beside a taller Client setup card (xl) the rows share the spare height, so the list fills the
 * card down to the auth hint instead of leaving a gap above it.
 */
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
      slim
      title={t("endpoints.title")}
    >
      <ul
        aria-label={t("endpoints.title")}
        className="flex grow flex-col divide-y divide-border-subtle"
      >
        {ENDPOINTS.map((endpoint) => {
          const title = t(endpoint.titleKey);
          const post = endpoint.method === "POST";
          return (
            <li
              className={cn("flex grow items-center gap-3 py-3", SETTINGS_ROW_X)}
              data-endpoint={endpoint.id}
              key={endpoint.id}
            >
              <IconChip icon={endpoint.icon} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <SettingsRowTitle>{title}</SettingsRowTitle>
                {/* A narrow row breaks between the host and the path, not inside either. */}
                <code
                  className="break-words font-mono text-meta leading-normal"
                  data-slot="endpoint-url"
                >
                  <span className="text-muted-foreground">{origin}</span>
                  <wbr />
                  <span className="text-foreground">{endpoint.path}</span>
                </code>
              </div>
              {/* One width for POST and GET, so the badges line up down the list. */}
              <Badge
                className="min-w-12 shrink-0 justify-center"
                size="sm"
                tone={post ? "primary" : "neutral"}
              >
                {post ? t("endpoints.methodPost") : t("endpoints.methodGet")}
              </Badge>
              <CopyButton
                className="-me-1.5 shrink-0"
                label={t(endpoint.copyKey)}
                value={origin + endpoint.path}
              />
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
