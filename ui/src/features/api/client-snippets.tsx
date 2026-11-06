import { CommandLineIcon, InfoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type ComponentProps, type JSX, useMemo } from "react";
import { CodeBlock } from "@/components/shared/code-block";
import { SectionCard } from "@/components/shared/section-card";
import { ROW_DESCRIPTION } from "@/components/shared/settings-rows";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { settingsQuery } from "@/lib/api/settings";
import type { CodeLanguage } from "@/lib/highlight";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CodeText } from "./code-text";
import { buildClientSnippets, SNIPPET_KEY_ENV } from "./snippets";

const CODEX_CONFIG_FILE = "~/.codex/config.toml";

/** A snippet in the shared code block; while it scrolls sideways its region is "<title> code". */
function Snippet({
  code,
  title,
  copyLabel,
  language,
}: {
  code: string;
  title: string;
  copyLabel: string;
  language: CodeLanguage;
}): JSX.Element {
  const { t } = useT("api");
  return (
    <CodeBlock
      code={code}
      copyLabel={copyLabel}
      language={language}
      regionLabel={t("snippets.codeRegion", { name: title })}
      title={title}
    />
  );
}

/*
 * The tab panels share one grid cell and stay mounted: the inactive ones keep their place
 * (inert and transparent: out of the tab order and the accessibility tree, and no animated icon
 * inside can paint through), so the card is always as tall
 * as its tallest panel (curl) and neither it nor the Endpoints card beside it changes height when
 * another tab is picked. The panel drops Base UI's `hidden` attribute for `data-inactive`: the
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

export function ClientSnippetsCard(): JSX.Element {
  const { t } = useT("api");
  const settings = useQuery(settingsQuery());
  const origin = window.location.origin;
  const snippets = useMemo(() => buildClientSnippets(origin), [origin]);
  const env = { env: SNIPPET_KEY_ENV };
  const copy = (name: string) => t("snippets.copy", { name });

  return (
    <SectionCard
      // One line, so this header lines up with the Endpoints header beside it at xl.
      description={<CodeText code={env} text={t("snippets.description")} />}
      icon={CommandLineIcon}
      id="api-client-setup"
      panelClassName="flex flex-col"
      title={t("snippets.title")}
    >
      <Tabs className="min-w-0 flex-1 gap-3" defaultValue="curl">
        {settings.data && !settings.data.requireApiKey ? (
          <Alert role="note" size="sm" variant="info">
            <HugeiconsIcon icon={InfoIcon} aria-hidden="true" />
            <AlertDescription>{t("snippets.anyKeyWorks")}</AlertDescription>
          </Alert>
        ) : null}
        {/* Four tabs fit one row on a 390 px phone; a narrower card scrolls them, faded at the edge. */}
        <ScrollArea className="h-auto max-w-full" clampContentMinWidth={false} scrollFade>
          <TabsList>
            <TabsTab value="curl">{t("snippets.curl")}</TabsTab>
            <TabsTab value="claude-code">{t("snippets.claudeCode")}</TabsTab>
            <TabsTab value="codex">{t("snippets.codex")}</TabsTab>
            <TabsTab value="openai-sdk">{t("snippets.openaiSdk")}</TabsTab>
          </TabsList>
        </ScrollArea>
        <div className={PANEL_STACK}>
          <StackedPanel className="flex min-w-0 flex-col gap-3" value="curl">
            <Snippet
              code={snippets.curl.anthropic}
              language="bash"
              copyLabel={copy(t("snippets.anthropicMessages"))}
              title={t("snippets.anthropicMessages")}
            />
            <Snippet
              code={snippets.curl.openai}
              language="bash"
              copyLabel={copy(t("snippets.openaiChat"))}
              title={t("snippets.openaiChat")}
            />
          </StackedPanel>
          <StackedPanel className="flex min-w-0 flex-col gap-3" value="claude-code">
            <Hint>{t("snippets.claudeCodeHint")}</Hint>
            <Snippet
              code={snippets.claudeCode}
              language="bash"
              copyLabel={copy(t("snippets.claudeCode"))}
              title={t("snippets.shell")}
            />
          </StackedPanel>
          <StackedPanel className="flex min-w-0 flex-col gap-3" value="codex">
            <Hint>
              <CodeText
                code={{ file: CODEX_CONFIG_FILE, env: SNIPPET_KEY_ENV }}
                text={t("snippets.codexHint")}
              />
            </Hint>
            <Snippet
              code={snippets.codex}
              language="toml"
              copyLabel={copy(t("snippets.codex"))}
              title={CODEX_CONFIG_FILE}
            />
          </StackedPanel>
          <StackedPanel className="flex min-w-0 flex-col" value="openai-sdk">
            <Tabs className="min-w-0 flex-1 gap-3" defaultValue="python">
              <TabsList aria-label={t("snippets.sdkLanguage")} size="sm" variant="underline">
                <TabsTab value="python">{t("snippets.python")}</TabsTab>
                <TabsTab value="typescript">{t("snippets.typescript")}</TabsTab>
              </TabsList>
              <div className={PANEL_STACK}>
                <StackedPanel className="flex min-w-0 flex-col" value="python">
                  <Snippet
                    code={snippets.openaiSdk.python}
                    language="python"
                    copyLabel={copy(
                      t("snippets.sdkWithLanguage", {
                        sdk: t("snippets.openaiSdk"),
                        language: t("snippets.python"),
                      }),
                    )}
                    title="main.py"
                  />
                </StackedPanel>
                <StackedPanel className="flex min-w-0 flex-col" value="typescript">
                  <Snippet
                    code={snippets.openaiSdk.typescript}
                    language="typescript"
                    copyLabel={copy(
                      t("snippets.sdkWithLanguage", {
                        sdk: t("snippets.openaiSdk"),
                        language: t("snippets.typescript"),
                      }),
                    )}
                    title="main.ts"
                  />
                </StackedPanel>
              </div>
            </Tabs>
          </StackedPanel>
        </div>
      </Tabs>
    </SectionCard>
  );
}
