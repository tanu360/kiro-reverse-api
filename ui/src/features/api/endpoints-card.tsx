import {
  CalculatorIcon,
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
    id: "count-tokens",
    icon: CalculatorIcon,
    titleKey: "endpoints.countTokens",
    copyKey: "endpoints.copyCountTokens",
    method: "POST",
    path: "/v1/messages/count_tokens",
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
        {ENDPOINTS.map((endpoint) => (
          <EndpointRow
            copyLabel={t(endpoint.copyKey)}
            icon={endpoint.icon}
            id={endpoint.id}
            key={endpoint.id}
            method={endpoint.method}
            methodLabel={
              endpoint.method === "POST" ? t("endpoints.methodPost") : t("endpoints.methodGet")
            }
            origin={origin}
            path={endpoint.path}
            title={t(endpoint.titleKey)}
          />
        ))}
      </ul>
    </SectionCard>
  );
}

/**
 * One row of an endpoint list (this card and the key holder's Connect card): the icon chip, the
 * name with its URL under it, the method and a copy button. A row without a path is the base URL:
 * its host is the whole value, so it is not muted, and it has no method.
 */
export function EndpointRow({
  id,
  icon,
  title,
  origin,
  path,
  method,
  methodLabel,
  copyLabel,
}: {
  id: string;
  icon: IconSvgElement;
  title: string;
  origin: string;
  path: string;
  method?: "POST" | "GET";
  methodLabel?: string;
  copyLabel: string;
}): JSX.Element {
  return (
    <li className={cn("flex grow items-center gap-3 py-3", SETTINGS_ROW_X)} data-endpoint={id}>
      <IconChip icon={icon} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <SettingsRowTitle>{title}</SettingsRowTitle>
        {/* A narrow row breaks between the host and the path, not inside either. */}
        <code
          className="wrap-break-word font-mono text-meta leading-normal"
          data-slot="endpoint-url"
        >
          <span className={path ? "text-muted-foreground" : "text-foreground"}>{origin}</span>
          <wbr />
          <span className="text-foreground">{path}</span>
        </code>
      </div>
      {method ? (
        // One width for POST and GET, so the badges line up down the list.
        <Badge
          className="min-w-12 shrink-0 justify-center"
          size="sm"
          tone={method === "POST" ? "primary" : "neutral"}
        >
          {methodLabel}
        </Badge>
      ) : null}
      <CopyButton className="-me-1.5 shrink-0" label={copyLabel} value={origin + path} />
    </li>
  );
}
