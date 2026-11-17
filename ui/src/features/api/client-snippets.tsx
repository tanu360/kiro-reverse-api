import {
  CodeIcon,
  CodeSquareIcon,
  CommandLineIcon,
  InfoIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import {
  type ComponentProps,
  type CSSProperties,
  type JSX,
  type SVGProps,
  useMemo,
  useState,
} from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
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

/** Each API wears its sticker from the sign-in showcase (index.css --sticker-*): peach, lime, periwinkle. */
const API_STICKERS: Record<SnippetApi, CSSProperties> = {
  messages: { "--tile-bg": "var(--sticker-claude)", "--tile-fg": "var(--sticker-claude-fg)" },
  chat: { "--tile-bg": "var(--sticker-openai)", "--tile-fg": "var(--sticker-openai-fg)" },
  responses: { "--tile-bg": "var(--sticker-codex)", "--tile-fg": "var(--sticker-codex-fg)" },
} as Record<SnippetApi, CSSProperties>;

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
  fillHeight,
}: Pick<
  ComponentProps<typeof CodeBlock>,
  "code" | "title" | "copyLabel" | "language" | "actions" | "capHeight" | "fillHeight"
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
      fillHeight={fillHeight}
      copyLabel={copyLabel}
      language={language}
      regionLabel={t("snippets.codeRegion", { name: name ?? title })}
      title={title}
    />
  );
}

/*
 * The tab panels share one grid cell and stay mounted. From xl, where the card sits beside
 * Endpoints, the inactive ones keep their place (inert and transparent: out of the tab order and
 * the accessibility tree, and no animated icon inside can paint through), so the card is always
 * as tall as its tallest panel (the request builder) and switching to Claude Code or Codex never
 * shrinks it or moves the page. Below xl the card stands alone in its column, so an inactive
 * panel takes no room and the card is as tall as the open tab: no empty area under a short
 * snippet on a phone. The panel drops Base UI's `hidden` attribute for `data-inactive`: the
 * preflight's `[hidden] { display: none !important }` sits in the base layer, which no utility
 * can override.
 */
const PANEL_STACK = "grid min-w-0 flex-1";

function StackedPanel({
  className,
  ...props
}: Omit<ComponentProps<typeof TabsPanel>, "keepMounted" | "render">): JSX.Element {
  return (
    <TabsPanel
      className={cn(
        "[grid-area:1/1] data-inactive:pointer-events-none data-inactive:invisible data-inactive:opacity-0 max-xl:data-inactive:hidden",
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

// The model picker's family chips (test-model-picker.tsx) at the 24 px small control height, 12 px
// text and logo, so all eight fit one line of the half-width card at 1440 px: the picked one
// inverted. A touch screen keeps the 32 px target.
const LANGUAGE_CHIP =
  "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 font-medium text-xs transition-colors focus-visible:focus-outline pointer-coarse:h-8 pointer-coarse:px-3 data-checked:bg-foreground data-checked:text-background data-unchecked:text-muted-foreground data-unchecked:shadow-[inset_0_0_0_1px_var(--border)] data-unchecked:hover:bg-accent data-unchecked:hover:text-foreground";

// One 36 px line (the default control height) in the API's sticker colours, as the sign-in
// showcase's labels: the pastel fill and its dark label. The others have no edge (a faint one on
// hover). The picked one has a 1.5 px edge in a deeper step of its own pastel (--tile-edge): no
// outer ring or glow, no dark outline. The keyboard's focus outline sits 2 px out. Phones drop
// the logo so "Completions" fits a third of the row.
const API_TILE =
  "flex h-9 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-lg bg-(--tile-bg) px-3 font-medium text-(--tile-fg) text-sm transition-shadow [--tile-edge:color-mix(in_oklab,var(--tile-fg)_50%,var(--tile-bg))] focus-visible:focus-outline data-checked:shadow-[inset_0_0_0_1.5px_var(--tile-edge)] data-unchecked:hover:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--tile-fg)_32%,transparent)] max-sm:flex-auto max-sm:px-2";

/*
 * Pick an API and a language; in Python and Node.js a switch in the code block's strip trades
 * the official SDK for the plain HTTP client. The tiles, the language chips and the code sit
 * 16 px apart. The chips stay on one line and scroll sideways, with faded edges where more hide.
 */
function RequestBuilder({ origin, model }: { origin: string; model?: string }): JSX.Element {
  const { t } = useT("api");
  const [choice, setChoice] = useState(readChoice);
  const update = (patch: Partial<RequestChoice>) => {
    const next = { ...choice, ...patch };
    setChoice(next);
    writeStorage(CHOICE_STORAGE_KEY, JSON.stringify(next));
  };

  const info = SNIPPET_LANGUAGE_INFO[choice.language];
  const request = useMemo(
    () => buildRequestSnippet(origin, choice, model),
    [origin, choice, model],
  );
  const requestName = t("snippets.request", { language: t(`snippets.lang.${choice.language}`) });

  return (
    <div className="flex min-w-0 flex-col gap-4 xl:flex-1">
      <RadioGroupPrimitive
        aria-label={t("snippets.endpoint")}
        // Phones: each tile as wide as its name, sharing out the spare width, and a tile that
        // does not fit wraps to a second line instead of cutting a name ("Completi…").
        className="grid grid-cols-3 gap-2 max-sm:flex max-sm:flex-wrap"
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
              style={API_STICKERS[api]}
              value={api}
            >
              <MakerLogo className="max-sm:hidden" maker={provider.maker} />
              <span className="truncate">{name}</span>
            </RadioPrimitive.Root>
          );
        })}
      </RadioGroupPrimitive>

      {/* One line: a card too narrow for all eight scrolls them sideways. The 4 px bleed (-m-1
          with p-1 inside) keeps the chips' focus outline unclipped. */}
      <ScrollArea className="-m-1 h-auto w-auto min-w-0" scrollFade>
        <RadioGroupPrimitive
          aria-label={t("snippets.language")}
          className="flex w-max gap-1.5 p-1"
          onValueChange={(language) => update({ language: language as SnippetLanguage })}
          value={choice.language}
        >
          {SNIPPET_LANGUAGES.map((language) => {
            const Logo = LANGUAGE_LOGOS[language];
            return (
              <RadioPrimitive.Root className={LANGUAGE_CHIP} key={language} value={language}>
                <Logo className="size-3 shrink-0" />
                {t(`snippets.lang.${language}`)}
              </RadioPrimitive.Root>
            );
          })}
        </RadioGroupPrimitive>
      </ScrollArea>

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
        code={request}
        // From xl the card is as tall as its tallest tab (Codex): the request fills down to the
        // card's bottom instead of stopping at 13 lines over an empty area.
        fillHeight
        copyLabel={t("snippets.copy", { name: requestName })}
        language={info.highlight}
        name={requestName}
        title={info.file ?? t("snippets.shell")}
      />
    </div>
  );
}

export function ClientSnippetsCard({
  requireApiKey,
  model,
}: {
  /**
   * The server's "Require API key", from a page that may not call /admin/api (the key holder's
   * /user): given, the card skips the settings query.
   */
  requireApiKey?: boolean;
  /** The model the request and the Codex config name; a key limited to models passes one of them. */
  model?: string;
} = {}): JSX.Element {
  const { t } = useT("api");
  // A key holder (requireApiKey given) has one key: the card speaks of it, and leaves "keys are
  // not required" to the panel's own alert, which says what that means for their usage.
  const keyHolder = requireApiKey !== undefined;
  const settings = useQuery({ ...settingsQuery(), enabled: !keyHolder });
  const required = requireApiKey ?? settings.data?.requireApiKey;
  const origin = window.location.origin;
  const tools = useMemo(() => buildToolSnippets(origin, model), [origin, model]);
  const env = { env: SNIPPET_KEY_ENV };

  return (
    <SectionCard
      // One line, so this header lines up with the Endpoints header beside it at xl.
      description={
        <CodeText
          code={env}
          text={t(keyHolder ? "snippets.descriptionHolder" : "snippets.description")}
        />
      }
      icon={CommandLineIcon}
      id="api-client-setup"
      // The tab strip sits 12 px under the header, as the status tabs sit in the Accounts and
      // Requests cards; everything under it is 16 px apart.
      panelClassName="flex flex-col pt-3 sm:pt-3"
      title={t("snippets.title")}
    >
      <Tabs className="min-w-0 flex-1 gap-4" defaultValue="api">
        {required === false && !keyHolder ? (
          <Alert role="note" size="sm" variant="info">
            <HugeiconsIcon icon={InfoIcon} aria-hidden="true" />
            <AlertDescription>{t("snippets.anyKeyWorks")}</AlertDescription>
          </Alert>
        ) : null}
        {/* Underlined over a full-width hairline, so the strip reads as tabs with their panel under it. */}
        <TabsList variant="underline">
          <TabsTab value="api">
            <HugeiconsIcon aria-hidden="true" className="max-sm:hidden" icon={CodeIcon} />
            {t("snippets.apiRequest")}
          </TabsTab>
          <TabsTab value="claude-code">
            <HugeiconsIcon aria-hidden="true" className="max-sm:hidden" icon={TerminalIcon} />
            {t("snippets.claudeCode")}
          </TabsTab>
          <TabsTab value="codex">
            <HugeiconsIcon aria-hidden="true" className="max-sm:hidden" icon={CodeSquareIcon} />
            {t("snippets.codex")}
          </TabsTab>
        </TabsList>
        <div className={PANEL_STACK}>
          <StackedPanel className="flex min-w-0 flex-col" value="api">
            <RequestBuilder model={model} origin={origin} />
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
