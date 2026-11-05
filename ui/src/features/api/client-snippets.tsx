import { CommandLineIcon, InfoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { type JSX, useMemo } from "react";
import { CodeBlock } from "@/components/shared/code-block";
import { SectionCard } from "@/components/shared/section-card";
import { ROW_DESCRIPTION } from "@/components/shared/settings-rows";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { settingsQuery } from "@/lib/api/settings";
import { useT } from "@/lib/i18n";
import { CodeText } from "./code-text";
import { buildClientSnippets, SNIPPET_KEY_ENV } from "./snippets";

const CODEX_CONFIG_FILE = "~/.codex/config.toml";

/** A snippet in the shared code block; while it scrolls sideways its region is "<title> code". */
function Snippet({
  code,
  title,
  copyLabel,
}: {
  code: string;
  title: string;
  copyLabel: string;
}): JSX.Element {
  const { t } = useT("api");
  return (
    <CodeBlock
      code={code}
      copyLabel={copyLabel}
      regionLabel={t("snippets.codeRegion", { name: title })}
      title={title}
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
        <TabsPanel className="flex min-w-0 flex-col gap-3" value="curl">
          <Snippet
            code={snippets.curl.anthropic}
            copyLabel={copy(t("snippets.anthropicMessages"))}
            title={t("snippets.anthropicMessages")}
          />
          <Snippet
            code={snippets.curl.openai}
            copyLabel={copy(t("snippets.openaiChat"))}
            title={t("snippets.openaiChat")}
          />
        </TabsPanel>
        <TabsPanel className="flex min-w-0 flex-col gap-3" value="claude-code">
          <Hint>{t("snippets.claudeCodeHint")}</Hint>
          <Snippet
            code={snippets.claudeCode}
            copyLabel={copy(t("snippets.claudeCode"))}
            title={t("snippets.shell")}
          />
        </TabsPanel>
        <TabsPanel className="flex min-w-0 flex-col gap-3" value="codex">
          <Hint>
            <CodeText
              code={{ file: CODEX_CONFIG_FILE, env: SNIPPET_KEY_ENV }}
              text={t("snippets.codexHint")}
            />
          </Hint>
          <Snippet
            code={snippets.codex}
            copyLabel={copy(t("snippets.codex"))}
            title={CODEX_CONFIG_FILE}
          />
        </TabsPanel>
        <TabsPanel className="flex min-w-0 flex-col" value="openai-sdk">
          <Tabs className="min-w-0 flex-1 gap-3" defaultValue="python">
            <TabsList aria-label={t("snippets.sdkLanguage")} size="sm" variant="underline">
              <TabsTab value="python">{t("snippets.python")}</TabsTab>
              <TabsTab value="typescript">{t("snippets.typescript")}</TabsTab>
            </TabsList>
            <TabsPanel className="flex min-w-0 flex-col" value="python">
              <Snippet
                code={snippets.openaiSdk.python}
                copyLabel={copy(
                  t("snippets.sdkWithLanguage", {
                    sdk: t("snippets.openaiSdk"),
                    language: t("snippets.python"),
                  }),
                )}
                title="main.py"
              />
            </TabsPanel>
            <TabsPanel className="flex min-w-0 flex-col" value="typescript">
              <Snippet
                code={snippets.openaiSdk.typescript}
                copyLabel={copy(
                  t("snippets.sdkWithLanguage", {
                    sdk: t("snippets.openaiSdk"),
                    language: t("snippets.typescript"),
                  }),
                )}
                title="main.ts"
              />
            </TabsPanel>
          </Tabs>
        </TabsPanel>
      </Tabs>
    </SectionCard>
  );
}
