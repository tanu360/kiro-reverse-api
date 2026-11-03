import { useQuery } from "@tanstack/react-query";
import { type JSX, useMemo, useRef } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { SectionCard } from "@/components/shared/section-card";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { settingsQuery } from "@/lib/api/settings";
import { useT } from "@/lib/i18n";
import { CodeText } from "./code-text";
import { buildClientSnippets, SNIPPET_KEY_ENV } from "./snippets";
import { useHorizontalOverflow } from "./use-element-size";

const CODEX_CONFIG_FILE = "~/.codex/config.toml";
// Four tabs fit in one row on a 390 px phone; narrower screens scroll the row.
const TAB_CLASS = "max-sm:px-2 max-sm:text-sm";

/**
 * A scrollable mono code block with its own copy button. Long lines never widen the page.
 * While the code scrolls sideways, the block is a labelled tab stop so arrow keys can scroll it.
 */
function CodeBlock({
  code,
  title,
  copyLabel,
}: {
  code: string;
  title: string;
  copyLabel: string;
}): JSX.Element {
  const { t } = useT("api");
  const preRef = useRef<HTMLPreElement>(null);
  const scrolls = useHorizontalOverflow(preRef, code);
  return (
    <figure className="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-muted/40">
      <div className="flex min-h-10 items-center justify-between gap-2 border-b py-1 ps-3 pe-1">
        <figcaption className="min-w-0 truncate font-medium text-muted-foreground text-xs">
          {title}
        </figcaption>
        <CopyButton label={copyLabel} value={code} />
      </div>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label is set only with role="region". */}
      <pre
        aria-label={scrolls ? t("snippets.codeRegion", { name: title }) : undefined}
        className="max-w-full overflow-x-auto rounded-b-lg p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        ref={preRef}
        role={scrolls ? "region" : undefined}
        tabIndex={scrolls ? 0 : undefined}
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}

function Hint({ children }: { children: JSX.Element | string }): JSX.Element {
  return <p className="text-muted-foreground text-sm">{children}</p>;
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
      description={
        <CodeText
          code={env}
          text={
            settings.data && !settings.data.requireApiKey
              ? t("common:text.joinSentences", {
                  first: t("snippets.description"),
                  second: t("snippets.anyKeyWorks"),
                })
              : t("snippets.description")
          }
        />
      }
      id="api-client-setup"
      title={t("snippets.title")}
    >
      <Tabs className="min-w-0 gap-4" defaultValue="curl">
        <div className="max-w-full overflow-x-auto">
          <TabsList>
            <TabsTab className={TAB_CLASS} value="curl">
              {t("snippets.curl")}
            </TabsTab>
            <TabsTab className={TAB_CLASS} value="claude-code">
              {t("snippets.claudeCode")}
            </TabsTab>
            <TabsTab className={TAB_CLASS} value="codex">
              {t("snippets.codex")}
            </TabsTab>
            <TabsTab className={TAB_CLASS} value="openai-sdk">
              {t("snippets.openaiSdk")}
            </TabsTab>
          </TabsList>
        </div>
        <TabsPanel className="flex min-w-0 flex-col gap-4" value="curl">
          <CodeBlock
            code={snippets.curl.anthropic}
            copyLabel={copy(t("snippets.anthropicMessages"))}
            title={t("snippets.anthropicMessages")}
          />
          <CodeBlock
            code={snippets.curl.openai}
            copyLabel={copy(t("snippets.openaiChat"))}
            title={t("snippets.openaiChat")}
          />
        </TabsPanel>
        <TabsPanel className="flex min-w-0 flex-col gap-3" value="claude-code">
          <Hint>{t("snippets.claudeCodeHint")}</Hint>
          <CodeBlock
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
          <CodeBlock
            code={snippets.codex}
            copyLabel={copy(t("snippets.codex"))}
            title={CODEX_CONFIG_FILE}
          />
        </TabsPanel>
        <TabsPanel className="min-w-0" value="openai-sdk">
          <Tabs className="min-w-0 gap-3" defaultValue="python">
            <TabsList aria-label={t("snippets.sdkLanguage")} size="sm" variant="underline">
              <TabsTab value="python">{t("snippets.python")}</TabsTab>
              <TabsTab value="typescript">{t("snippets.typescript")}</TabsTab>
            </TabsList>
            <TabsPanel className="min-w-0" value="python">
              <CodeBlock
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
            <TabsPanel className="min-w-0" value="typescript">
              <CodeBlock
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
