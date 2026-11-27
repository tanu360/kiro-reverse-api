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
import type { JSX } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { IconChip } from "@/components/shared/icon-chip";
import { SectionCard } from "@/components/shared/section-card";
import { SETTINGS_ROW_X, SettingsRowTitle } from "@/components/shared/settings-rows";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CodeText } from "./code-text";
import { useKeyRequiredHere } from "./use-key-required";

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
export function EndpointsCard({
  requireApiKey,
}: {
  /**
   * The server's "Require API key", from a page that may not call /admin/api (the key holder's
   * /user): given, the card skips the settings query, and the key hint speaks to the key holder,
   * since the admin one points at this page's keys and the admin password.
   */
  requireApiKey?: boolean;
} = {}): JSX.Element {
  const { t } = useT("api");
  const keyHolder = requireApiKey !== undefined;
  // Through the public link the URLs below are the link's, where every call needs a key.
  const keyRequired = useKeyRequiredHere(!keyHolder);
  const origin = window.location.origin;
  const required = requireApiKey ?? keyRequired ?? false;
  // A key holder reads the same line either way: with keys not required the proxy ignores a key
  // sent to it, and the user panel already says so above this card.
  const authHint = keyHolder
    ? t("endpoints.holderAuthRequired")
    : required
      ? t("endpoints.authRequired")
      : t("endpoints.authOptional");

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
              text={authHint}
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
 * One row of the endpoint list: the icon chip, the name with its URL under it, the method and a
 * copy button.
 */
function EndpointRow({
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
  method: "POST" | "GET";
  methodLabel: string;
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
          <span className="text-muted-foreground">{origin}</span>
          <wbr />
          <span className="text-foreground">{path}</span>
        </code>
      </div>
      {/* One width for POST and GET, so the badges line up down the list. */}
      <Badge
        className="min-w-12 shrink-0 justify-center"
        size="sm"
        tone={method === "POST" ? "primary" : "neutral"}
      >
        {methodLabel}
      </Badge>
      {/* The icon, not the invisible box, lines up with the card's content edge. */}
      <CopyButton className="-me-2.5 shrink-0" label={copyLabel} value={origin + path} />
    </li>
  );
}
