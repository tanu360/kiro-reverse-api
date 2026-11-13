import { CommandLineIcon, InfoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type ComponentProps, type JSX, type SVGProps, useMemo, useState } from "react";
import { CodeBlock } from "@/components/shared/code-block";
import {
  CSharpLogo,
  CurlLogo,
  GoLogo,
  JavaLogo,
  NodeLogo,
  PhpLogo,
  PythonLogo,
  RubyLogo,
} from "@/components/shared/language-logos";
import { MakerLogo } from "@/components/shared/model-logo";
import { SectionCard } from "@/components/shared/section-card";
import { ROW_DESCRIPTION } from "@/components/shared/settings-rows";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { settingsQuery } from "@/lib/api/settings";
import { useT } from "@/lib/i18n";
import { readStorage, writeStorage } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { CodeText } from "./code-text";
import {
  buildRequestSnippet,
  buildToolSnippets,
  CODEX_CATALOG_FILE,
  SNIPPET_APIS,
  SNIPPET_KEY_ENV,
  SNIPPET_LANGUAGE_INFO,
  SNIPPET_LANGUAGES,
  type SnippetApi,
  type SnippetClient,
  type SnippetLanguage,
  sdkProvider,
  usesSdk,
} from "./snippets";

const CODEX_CONFIG_FILE = "~/.codex/config.toml";

type Mark = (props: Omit<SVGProps<SVGSVGElement>, "children" | "viewBox">) => JSX.Element;

// MakerLogo's OpenAI mark is currentColor, so it reads in both themes.
const API_PROVIDERS: Record<SnippetApi, { name: string; maker: "claude" | "openai" }> = {
  messages: { name: "Anthropic", maker: "claude" },
  chat: { name: "OpenAI", maker: "openai" },
  responses: { name: "OpenAI", maker: "openai" },
};

const LANGUAGE_LOGOS: Record<SnippetLanguage, Mark> = {
  curl: CurlLogo,
  python: PythonLogo,
  node: NodeLogo,
  go: GoLogo,
  java: JavaLogo,
  php: PhpLogo,
  ruby: RubyLogo,
  csharp: CSharpLogo,
};

interface RequestChoice {
  api: SnippetApi;
  language: SnippetLanguage;
  client: SnippetClient;
}

const DEFAULT_CHOICE: RequestChoice = {
  api: "messages",
  language: "curl",
  client: "sdk",
};

// The request builder's picks, kept per browser so the page opens on the reader's own stack.
const CHOICE_STORAGE_KEY = "kiro_client_snippet";

function pick<T extends string>(options: readonly T[], value: unknown, fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function readChoice(): RequestChoice {
  const raw = readStorage(CHOICE_STORAGE_KEY);
  if (!raw) return DEFAULT_CHOICE;
  try {
    const saved = JSON.parse(raw) as Partial<Record<keyof RequestChoice, unknown>>;
    return {
      api: pick(SNIPPET_APIS, saved.api, DEFAULT_CHOICE.api),
      language: pick(SNIPPET_LANGUAGES, saved.language, DEFAULT_CHOICE.language),
      client: pick(["sdk", "http"] as const, saved.client, DEFAULT_CHOICE.client),
    };
  } catch {
    return DEFAULT_CHOICE;
  }
}

/** A snippet in the shared code block; while it scrolls sideways its region is "<name> code". */
function Snippet({
  code,
  title,
  name,
  copyLabel,
  language,
  actions,
  capHeight,
}: Pick<
  ComponentProps<typeof CodeBlock>,
  "code" | "title" | "copyLabel" | "language" | "actions" | "capHeight"
> & {
  /** What the code is, for the scrolling region's name; the title by default. */
  name?: string;
}): JSX.Element {
  const { t } = useT("api");
  return (
    <CodeBlock
      actions={actions}
      capHeight={capHeight}
      code={code}
      copyLabel={copyLabel}
      language={language}
      regionLabel={t("snippets.codeRegion", { name: name ?? title })}
      title={title}
    />
  );
}

/*
 * The tab panels share one grid cell and stay mounted: the inactive ones keep their place
 * (inert and transparent: out of the tab order and the accessibility tree, and no animated icon
 * inside can paint through), so the card is always as tall as its tallest panel (the request
 * builder) and switching to Claude Code or Codex never shrinks it. The panel drops Base UI's
 * `hidden` attribute for `data-inactive`: the preflight's `[hidden] { display: none !important }`
 * sits in the base layer, which no utility can override.
 */
const PANEL_STACK = "grid min-w-0 flex-1";

function StackedPanel({
  className,
  ...props
}: Omit<ComponentProps<typeof TabsPanel>, "keepMounted" | "render">): JSX.Element {
  return (
    <TabsPanel
      className={cn(
        "[grid-area:1/1] data-inactive:pointer-events-none data-inactive:invisible data-inactive:opacity-0",
        className,
      )}
      keepMounted
      render={(panelProps, state) => (
        <div
          {...panelProps}
          data-inactive={state.hidden ? "" : undefined}
          hidden={undefined}
          inert={state.hidden || undefined}
        />
      )}
      {...props}
    />
  );
}

function Hint({ children }: { children: JSX.Element | string }): JSX.Element {
  return <p className={ROW_DESCRIPTION}>{children}</p>;
}

// The model picker's family chips (test-model-picker.tsx) at the 32 px control height: the picked
// one inverted.
const LANGUAGE_CHIP =
  "inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-full px-3 font-medium text-sm outline-none transition-colors focus-visible:focus-outline data-checked:bg-foreground data-checked:text-background data-unchecked:text-muted-foreground data-unchecked:shadow-[inset_0_0_0_1px_var(--border)] data-unchecked:hover:bg-accent data-unchecked:hover:text-foreground";

// The ChoiceCard look (choice-card.tsx) on the radio itself, one 36 px line (the default control
// height): the logo beside the name, muted until checked, then the accent fill and primary edge.
// Phones drop the logo so "Completions" fits a third of the row.
const API_TILE =
  "flex h-9 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border px-3 font-medium text-muted-foreground text-sm outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:focus-outline data-checked:border-primary/48 data-checked:bg-accent data-checked:text-foreground max-sm:px-2";

/*
 * Pick an API and a language; in Python and Node.js a switch in the code block's strip trades
 * the official SDK for the plain HTTP client. The tiles, the language chips and the code sit
 * 16 px apart, and the chips wrap instead of scrolling, so none is ever cut off.
 */
function RequestBuilder({ origin }: { origin: string }): JSX.Element {
  const { t } = useT("api");
  const [choice, setChoice] = useState(readChoice);
  const update = (patch: Partial<RequestChoice>) => {
    const next = { ...choice, ...patch };
    setChoice(next);
    writeStorage(CHOICE_STORAGE_KEY, JSON.stringify(next));
  };

  const info = SNIPPET_LANGUAGE_INFO[choice.language];
  const request = useMemo(() => buildRequestSnippet(origin, choice), [origin, choice]);
  const requestName = t("snippets.request", { language: t(`snippets.lang.${choice.language}`) });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <RadioGroupPrimitive
        aria-label={t("snippets.endpoint")}
        className="grid grid-cols-3 gap-2"
        onValueChange={(api) => update({ api: api as SnippetApi })}
        value={choice.api}
      >
        {SNIPPET_APIS.map((api) => {
          const provider = API_PROVIDERS[api];
          const name = t(`snippets.api.${api}`);
          return (
            <RadioPrimitive.Root
              // The logo shows the provider; the name read out says it.
              aria-label={`${provider.name} ${name}`}
              className={API_TILE}
              key={api}
              value={api}
            >
              <MakerLogo className="max-sm:hidden" maker={provider.maker} />
              <span className="truncate">{name}</span>
            </RadioPrimitive.Root>
          );
        })}
      </RadioGroupPrimitive>

      {/* All eight in view: a card too narrow for one row wraps them onto the next. */}
      <RadioGroupPrimitive
        aria-label={t("snippets.language")}
        className="flex min-w-0 flex-wrap gap-2"
        onValueChange={(language) => update({ language: language as SnippetLanguage })}
        value={choice.language}
      >
        {SNIPPET_LANGUAGES.map((language) => {
          const Logo = LANGUAGE_LOGOS[language];
          return (
            <RadioPrimitive.Root className={LANGUAGE_CHIP} key={language} value={language}>
              <Logo className="size-4 shrink-0" />
              {t(`snippets.lang.${language}`)}
            </RadioPrimitive.Root>
          );
        })}
      </RadioGroupPrimitive>

      <Snippet
        actions={
          info.sdk ? (
            // On: the official SDK; off: the language's plain HTTP client.
            <Label className="cursor-pointer gap-1.5 text-meta">
              <Switch
                checked={usesSdk(choice)}
                onCheckedChange={(on) => update({ client: on ? "sdk" : "http" })}
              />
              {t("snippets.sdk", { name: sdkProvider(choice.api) })}
            </Label>
          ) : null
        }
        capHeight
        code={request}
        copyLabel={t("snippets.copy", { name: requestName })}
        language={info.highlight}
        name={requestName}
        title={info.file ?? t("snippets.shell")}
      />
    </div>
  );
}

export function ClientSnippetsCard(): JSX.Element {
  const { t } = useT("api");
  const settings = useQuery(settingsQuery());
  const origin = window.location.origin;
  const tools = useMemo(() => buildToolSnippets(origin), [origin]);
  const env = { env: SNIPPET_KEY_ENV };

  return (
    <SectionCard
      // One line, so this header lines up with the Endpoints header beside it at xl.
      description={<CodeText code={env} text={t("snippets.description")} />}
      icon={CommandLineIcon}
      id="api-client-setup"
      // The tab strip sits 12 px under the header, as the status tabs sit in the Accounts and
      // Requests cards; everything under it is 16 px apart.
      panelClassName="flex flex-col pt-3 sm:pt-3"
      title={t("snippets.title")}
    >
      <Tabs className="min-w-0 flex-1 gap-4" defaultValue="api">
        {settings.data && !settings.data.requireApiKey ? (
          <Alert role="note" size="sm" variant="info">
            <HugeiconsIcon icon={InfoIcon} aria-hidden="true" />
            <AlertDescription>{t("snippets.anyKeyWorks")}</AlertDescription>
          </Alert>
        ) : null}
        {/* Underlined over a full-width hairline, so the strip reads as tabs with their panel under it. */}
        <TabsList variant="underline">
          <TabsTab value="api">{t("snippets.apiRequest")}</TabsTab>
          <TabsTab value="claude-code">{t("snippets.claudeCode")}</TabsTab>
          <TabsTab value="codex">{t("snippets.codex")}</TabsTab>
        </TabsList>
        <div className={PANEL_STACK}>
          <StackedPanel className="flex min-w-0 flex-col" value="api">
            <RequestBuilder origin={origin} />
          </StackedPanel>
          <StackedPanel className="flex min-w-0 flex-col gap-4" value="claude-code">
            <Hint>{t("snippets.claudeCodeHint")}</Hint>
            <Snippet
              code={tools.claudeCode}
              language="bash"
              copyLabel={t("snippets.copy", { name: t("snippets.claudeCode") })}
              title={t("snippets.shell")}
            />
          </StackedPanel>
          <StackedPanel className="flex min-w-0 flex-col gap-4" value="codex">
            {/* First the model list: Codex never fetches it, and needs it for apply_patch. */}
            <Hint>
              <CodeText
                code={{ file: CODEX_CATALOG_FILE, tool: "apply_patch" }}
                text={t("snippets.codexModelsHint")}
              />
            </Hint>
            <Snippet
              code={tools.codexModels}
              language="bash"
              copyLabel={t("snippets.copy", { name: t("snippets.codexModels") })}
              name={t("snippets.codexModels")}
              title={t("snippets.shell")}
            />
            <Hint>
              <CodeText
                code={{ file: CODEX_CONFIG_FILE, env: SNIPPET_KEY_ENV }}
                text={t("snippets.codexHint")}
              />
            </Hint>
            <Snippet
              code={tools.codex}
              language="toml"
              copyLabel={t("snippets.copy", { name: t("snippets.codex") })}
              title={CODEX_CONFIG_FILE}
            />
          </StackedPanel>
        </div>
      </Tabs>
    </SectionCard>
  );
}
