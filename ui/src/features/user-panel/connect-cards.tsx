import {
  CommandLineIcon,
  Globe02Icon,
  KeyRoundIcon,
  Layers01Icon,
  Link01Icon,
  MessageSquareIcon,
  WandSparklesIcon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type JSX, useMemo, useState } from "react";
import { CodeBlock } from "@/components/shared/code-block";
import { CopyButton } from "@/components/shared/copy-button";
import { IconChip } from "@/components/shared/icon-chip";
import { SectionCard } from "@/components/shared/section-card";
import { SETTINGS_ROW_X, SettingsRowTitle } from "@/components/shared/settings-rows";
import { Badge } from "@/components/ui/badge";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { CodeText } from "@/features/api/code-text";
import {
  buildRequestSnippet,
  SNIPPET_APIS,
  SNIPPET_KEY_ENV,
  SNIPPET_MODEL,
  type SnippetApi,
} from "@/features/api/snippets";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Stands in for the key everywhere on the page: the page never has the key itself. */
export const KEY_PLACEHOLDER = "YOUR_API_KEY";

interface Endpoint {
  id: string;
  icon: IconSvgElement;
  titleKey: string;
  /** No method for the base URL row. */
  method?: "POST" | "GET";
  path: string;
}

/** The base URL, then the public endpoints a key holder calls (handler.go router). */
const ENDPOINTS: readonly Endpoint[] = [
  { id: "base", icon: Link01Icon, titleKey: "connect.baseUrl", path: "" },
  {
    id: "messages",
    icon: MessageSquareIcon,
    titleKey: "connect.messages",
    method: "POST",
    path: "/v1/messages",
  },
  {
    id: "chat",
    icon: WandSparklesIcon,
    titleKey: "connect.chat",
    method: "POST",
    path: "/v1/chat/completions",
  },
  {
    id: "responses",
    icon: ZapIcon,
    titleKey: "connect.responses",
    method: "POST",
    path: "/v1/responses",
  },
  {
    id: "models",
    icon: Layers01Icon,
    titleKey: "connect.models",
    method: "GET",
    path: "/v1/models",
  },
];

const AUTH_HEADERS = {
  bearer: `Authorization: Bearer ${KEY_PLACEHOLDER}`,
  xApiKey: `x-api-key: ${KEY_PLACEHOLDER}`,
};

/**
 * The admin Endpoints card for a key holder: the base URL and the four endpoints as a flush
 * list (icon chip, name over the URL with the host muted, method, copy), and how to send the key
 * in the footer. The origin is this page's own, so it is the public link when opened through it.
 */
export function UserEndpointsCard(): JSX.Element {
  const { t } = useT("user-panel");
  const origin = window.location.origin;
  return (
    <SectionCard
      description={t("connect.description")}
      footer={
        <p className="flex items-start gap-2">
          <HugeiconsIcon
            icon={KeyRoundIcon}
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span data-testid="user-auth-hint">
            <CodeText code={AUTH_HEADERS} text={t("connect.auth")} />
          </span>
        </p>
      }
      icon={Globe02Icon}
      id="user-endpoints"
      slim
      title={t("connect.title")}
    >
      <ul
        aria-label={t("connect.title")}
        className="flex grow flex-col divide-y divide-border-subtle"
      >
        {ENDPOINTS.map((endpoint) => {
          const title = t(endpoint.titleKey);
          const url = origin + endpoint.path;
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
                <code className="wrap-break-word font-mono text-meta leading-normal">
                  <span className={endpoint.path ? "text-muted-foreground" : "text-foreground"}>
                    {origin}
                  </span>
                  <wbr />
                  <span className="text-foreground">{endpoint.path}</span>
                </code>
              </div>
              {endpoint.method ? (
                // One width for POST and GET, so the badges line up down the list.
                <Badge
                  className="min-w-12 shrink-0 justify-center"
                  size="sm"
                  tone={endpoint.method === "POST" ? "primary" : "neutral"}
                >
                  {endpoint.method === "POST" ? t("connect.post") : t("connect.get")}
                </Badge>
              ) : null}
              <CopyButton
                className="-me-1.5 shrink-0"
                label={
                  endpoint.path ? t("connect.copyUrl", { name: title }) : t("connect.copyBaseUrl")
                }
                value={url}
              />
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}

function isSnippetApi(value: unknown): value is SnippetApi {
  return typeof value === "string" && (SNIPPET_APIS as readonly string[]).includes(value);
}

/**
 * A curl request to the chosen API, the admin Client setup card's curl snippet with
 * YOUR_API_KEY where the key goes. A key limited to some models asks for the first of them, so
 * the example works as pasted.
 */
export function ExampleRequestCard({ allowedModels }: { allowedModels: string[] }): JSX.Element {
  const { t } = useT("user-panel");
  const [api, setApi] = useState<SnippetApi>("messages");
  const origin = window.location.origin;
  const model = allowedModels[0] ?? SNIPPET_MODEL;
  const code = useMemo(
    () =>
      buildRequestSnippet(origin, { api, language: "curl", client: "http" }, model).replaceAll(
        `$${SNIPPET_KEY_ENV}`,
        KEY_PLACEHOLDER,
      ),
    [origin, api, model],
  );
  return (
    <SectionCard
      actions={
        <SegmentedControl
          render={
            <RadioGroupPrimitive
              aria-label={t("connect.api")}
              onValueChange={(next) => {
                if (isSnippetApi(next)) setApi(next);
              }}
              value={api}
            />
          }
          size="sm"
        >
          {SNIPPET_APIS.map((value) => (
            <SegmentedControlItem key={value} render={<RadioPrimitive.Root value={value} />}>
              {t(`connect.api.${value}`)}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      }
      description={
        <CodeText code={{ placeholder: KEY_PLACEHOLDER }} text={t("connect.exampleDescription")} />
      }
      icon={CommandLineIcon}
      id="user-example"
      title={t("connect.example")}
    >
      <CodeBlock
        code={code}
        copyLabel={t("connect.copyExample")}
        language="bash"
        regionLabel={t("connect.exampleRegion")}
        title={t("connect.shell")}
      />
    </SectionCard>
  );
}
