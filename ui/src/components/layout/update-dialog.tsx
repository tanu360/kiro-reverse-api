import {
  ArrowRight02Icon,
  ExternalLinkIcon,
  SparklesIcon,
  WrenchIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, type ReactNode, useId, useMemo, useState } from "react";
import { ChoiceCard } from "@/components/shared/choice-card";
import { CopyField } from "@/components/shared/code-field";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Radio,
  RadioGroup,
  RadioGroupPrimitive,
  RadioPrimitive,
} from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { CodeText } from "@/features/api/code-text";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { RemoteVersionJson, VersionResponse } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn, keyByText } from "@/lib/utils";
import { GITHUB_URL } from "./user-menu";

/*
 * How a running proxy is updated. The Compose file builds from the clone, the image on ghcr.io is
 * rebuilt from main on every push (docker.yml), and a new version.json version on main publishes
 * release archives (release.yml, .github/scripts/build-release.sh): kiro-proxy-<platform>.tar.gz, .zip on Windows,
 * each holding one kiro-proxy-<platform> folder. /releases/latest/download/<file> follows the
 * newest release, so the command needs no version in it.
 */
const COMPOSE_COMMAND = "git pull && docker compose up -d --build";
const IMAGE_COMMAND = "docker pull ghcr.io/tanu360/kiro-reverse-api:latest";
const RELEASE_DOWNLOAD = "https://github.com/tanu360/kiro-reverse-api/releases/latest/download";

export type UpdateMethod = "compose" | "image" | "binary";

/** The platforms build-release.sh packages, by GOOS/GOARCH: the archive's platform part and the locale key of the name the steps show. */
const RELEASE_TARGETS: Record<string, { name: string; label: string }> = {
  "linux/amd64": { name: "linux-x64", label: "shell.update.platformLinuxX64" },
  "linux/arm64": { name: "linux-arm64", label: "shell.update.platformLinuxArm64" },
  "darwin/amd64": { name: "macos-intel", label: "shell.update.platformMacosIntel" },
  "darwin/arm64": { name: "macos-apple-silicon", label: "shell.update.platformMacosAppleSilicon" },
  "windows/amd64": { name: "windows-x64", label: "shell.update.platformWindowsX64" },
  "windows/arm64": { name: "windows-arm64", label: "shell.update.platformWindowsArm64" },
};
const FALLBACK_TARGET = "linux/amd64";

/** "v2.1.0" and "2.1.0" both display as "2.1.0", the one format the shell shows. */
export function stripV(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** A leading emoji (with its variation selector or ZWJ sequence), used as the line's marker. */
const LEADING_EMOJI = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*/u;
/** A markdown or typed bullet, dropped: the list draws its own marker. */
const LEADING_BULLET = /^[-*•]\s+/;
/** "New:", "Fixed:" and the like, set in medium weight. */
const LEADING_TAG = /^((?:new|fixed|fix|changed|improved|removed|breaking|security)\s*:)\s*/i;
/** The tags that file a line under Fixes. */
const FIX_TAG = /^fix(?:ed)?\s*:$/i;
/**
 * A plain lowercase first word ("the", "a", "self-heal"), capitalised once its "Fixed:" is gone.
 * A name such as max_tokens or deepseek-3.2 keeps its case.
 */
const PLAIN_FIRST_WORD = /^\p{Ll}+(?:['’-]\p{Ll}+)*(?=[\s,.;:!?)]|$)/u;

interface ChangelogLine {
  /** The line's text, numbered when it repeats (keyByText). */
  key: string;
  marker: string | null;
  tag: string | null;
  text: string;
}

/** One list item per non-empty changelog line: its emoji marker, a "Fixed:" tag, the text. */
export function parseChangelog(changelog: string): ChangelogLine[] {
  const lines = changelog
    .split(/\r?\n/)
    .map((line) => line.trim().replace(LEADING_BULLET, ""))
    .filter(Boolean);
  return keyByText(lines, (line) => line).map(({ key, item: line }) => {
    const emoji = LEADING_EMOJI.exec(line);
    const rest = emoji ? line.slice(emoji[0].length) : line;
    const tag = LEADING_TAG.exec(rest);
    return {
      key,
      marker: emoji ? emoji[1] : null,
      tag: tag ? tag[1] : null,
      text: tag ? rest.slice(tag[0].length) : rest,
    };
  });
}

/** Capitalises a plain first word; names and code (max_tokens, deepseek-3.2, GET) stay as they are. */
export function capitalizeFirst(text: string): string {
  return PLAIN_FIRST_WORD.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * The changelog in two lists: the "Fixed:" lines (without the tag, capitalised) and everything
 * else, each in its original order.
 */
export function splitChangelog(changelog: string | undefined): {
  news: ChangelogLine[];
  fixes: ChangelogLine[];
} {
  const news: ChangelogLine[] = [];
  const fixes: ChangelogLine[] = [];
  for (const line of parseChangelog(changelog ?? "")) {
    if (line.tag && FIX_TAG.test(line.tag)) {
      fixes.push({ ...line, tag: null, text: capitalizeFirst(line.text) });
    } else {
      news.push(line);
    }
  }
  return { news, fixes };
}

export interface ReleaseArchive {
  /** The archive's file name on the release. */
  file: string;
  /** The one folder the archive holds (and the old install sits in). */
  folder: string;
  windows: boolean;
  /** Locale key of the platform the archive is built for, shown as "macOS (Apple silicon)". */
  platformLabel: string;
  /** False when the server did not say or no archive is built for it: then linux-x64. */
  known: boolean;
}

/** The release archive for the server's platform, or the linux-x64 one when there is none. */
export function releaseArchive(server?: Pick<VersionResponse, "os" | "arch">): ReleaseArchive {
  const reported = `${server?.os ?? ""}/${server?.arch ?? ""}`;
  const known = Object.hasOwn(RELEASE_TARGETS, reported);
  const key = known ? reported : FALLBACK_TARGET;
  const target = RELEASE_TARGETS[key];
  const folder = `kiro-proxy-${target.name}`;
  const windows = key.startsWith("windows/");
  return {
    file: `${folder}.${windows ? "zip" : "tar.gz"}`,
    folder,
    windows,
    platformLabel: target.label,
    known,
  };
}

/** Downloads the archive and unpacks it over the old folder: curl and tar, or PowerShell. */
export function binaryCommand(archive: ReleaseArchive): string {
  const url = `${RELEASE_DOWNLOAD}/${archive.file}`;
  return archive.windows
    ? `curl.exe -fLO ${url}; Expand-Archive -Force ${archive.file} .`
    : `curl -fLO ${url} && tar -xzf ${archive.file}`;
}

/**
 * The method the How to update tab opens on: Docker Compose in a container (the image steps are
 * one tap away), the binary when the server runs outside one, Compose for a server that did not
 * say (older than the runtime fields).
 */
export function preferredMethod(server?: VersionResponse): UpdateMethod {
  if (server?.docker) return "compose";
  return server?.os ? "binary" : "compose";
}

export function UpdateDialog({
  open,
  onOpenChange,
  current,
  latest,
  server,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string;
  latest: RemoteVersionJson | null;
  /** GET /admin/api/version: the server's platform and whether it runs in a container. */
  server?: VersionResponse;
}): JSX.Element {
  const { t } = useT();
  const download = latest?.download ?? "";
  // Only an https link from the remote file is followed; otherwise the repository.
  const projectUrl = download.startsWith("https://") ? download : GITHUB_URL;
  const next = latest?.version ? stripV(latest.version) : "";
  const changes = useMemo(() => splitChangelog(latest?.changelog), [latest?.changelog]);
  const hasChanges = changes.news.length + changes.fixes.length > 0;
  // Phones: top-anchored, the dialog fills the 90dvh box whatever it shows, one pane at a time
  // behind two tabs. From sm up the panes sit side by side in a body of one fixed height. Either
  // way no tab, filter or method changes the dialog's height: each pane scrolls on its own.
  const phone = useMediaQuery("max-sm");

  return (
    <ResponsiveDialog
      anchor={phone ? "top" : "center"}
      description={t("shell.update.newVersionMessage")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            {t("actions.close")}
          </Button>
          <Button render={<a href={projectUrl} rel="noopener noreferrer" target="_blank" />}>
            {t("shell.update.openGithub")}
            <HugeiconsIcon icon={ExternalLinkIcon} aria-hidden="true" />
          </Button>
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      panel={false}
      size={hasChanges ? "3xl" : "lg"}
      title={
        // The title, then a pill that reads the change: the running version, an arrow, the new
        // one in purple. It wraps under the title when a translation is long.
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {t("shell.update.title")}
          {/* A space, so the heading's name reads "Version update 2.1.0 to 2.2.0". */}{" "}
          {current && next ? (
            <Badge>
              {/* Each drawn piece is hidden on its own: aria-hidden on a display:contents
                  wrapper does not hide its children from Chrome's accessible name. */}
              <span aria-hidden="true">{stripV(current)}</span>
              <HugeiconsIcon aria-hidden="true" data-badge-icon="line" icon={ArrowRight02Icon} />
              <span aria-hidden="true" className="font-semibold text-info-foreground">
                {next}
              </span>
              <span className="sr-only">
                {t("shell.update.versionChange", { current: stripV(current), latest: next })}
              </span>
            </Badge>
          ) : null}
        </span>
      }
    >
      <UpdateBody changes={changes} latest={next} phone={phone} server={server} />
    </ResponsiveDialog>
  );
}

/*
 * The body under the header: a hairline, then one fixed height from sm up (480 px), so the
 * dialog never grows or shrinks; on phones it takes what the 90dvh dialog leaves.
 */
const BODY = "flex min-h-0 flex-1 flex-col border-border-subtle border-t sm:h-120 sm:flex-none";

type Pane = "changes" | "how";

/**
 * The changes and How to update. From sm up they are two panes side by side, How to update on
 * the inset tint at the end; on phones two underlined tabs show one at a time. Without a
 * changelog How to update is the whole body.
 */
function UpdateBody({
  changes,
  latest,
  phone,
  server,
}: {
  changes: { news: ChangelogLine[]; fixes: ChangelogLine[] };
  /** The new version, for the step that says what the sidebar shows after the update. */
  latest: string;
  phone: boolean;
  server?: VersionResponse;
}): JSX.Element {
  const { t, lang } = useT();
  const [pane, setPane] = useState<Pane>("changes");
  const total = changes.news.length + changes.fixes.length;

  if (total === 0) {
    return (
      <div className={BODY}>
        <HowToUpdate heading={!phone} latest={latest} server={server} />
      </div>
    );
  }
  if (phone) {
    return (
      <Tabs
        className="min-h-0 flex-1 gap-0"
        onValueChange={(value) => setPane(value as Pane)}
        value={pane}
      >
        {/* The strip lines up with the dialog's 16 px phone edge, as the header above it. */}
        <div className="px-4">
          <TabsList aria-label={t("shell.update.title")} variant="underline">
            <TabsTab value="changes">
              {t("shell.update.tabChanges")}
              <Badge
                className="min-w-5"
                size="sm"
                tone={pane === "changes" ? "primary" : "neutral"}
              >
                {formatNumber(total, lang)}
              </Badge>
            </TabsTab>
            <TabsTab value="how">{t("shell.update.howTo")}</TabsTab>
          </TabsList>
        </div>
        {/* The scroll box inside is the tab stop while it overflows, so the panel is not one. */}
        <TabsPanel className="flex min-h-0 flex-col" tabIndex={-1} value="changes">
          <ChangesPane fixes={changes.fixes} news={changes.news} />
        </TabsPanel>
        <TabsPanel className="flex min-h-0 flex-col" tabIndex={-1} value="how">
          <HowToUpdate heading={false} latest={latest} server={server} />
        </TabsPanel>
      </Tabs>
    );
  }
  return (
    <div className={cn(BODY, "grid grid-cols-[minmax(0,1fr)_22rem]")}>
      <ChangesPane fixes={changes.fixes} news={changes.news} />
      <div className="flex min-h-0 flex-col border-border-subtle border-s bg-surface-inset">
        <HowToUpdate heading latest={latest} server={server} />
      </div>
    </div>
  );
}

/** A pane's top row: one 32 px line (the filter's height), so both panes' rows line up. */
const PANE_TOP = "flex min-h-8 shrink-0 items-center px-6 pt-4 pb-3 max-sm:px-4";
/** A pane's scrolling part: its own scroll box, fading the edge that has more past it. */
const PANE_SCROLL = "min-h-0 flex-1";
const PANE_CONTENT = "px-6 pb-6 max-sm:px-4";

type ChangeFilter = "all" | "news" | "fixes";

/**
 * The changelog. With both kinds of lines, a filter shows All (New, then Fixes, each under its
 * label), New or Fixes, with their counts; with one kind, its name heads the list instead.
 */
function ChangesPane({
  news,
  fixes,
}: {
  news: ChangelogLine[];
  fixes: ChangelogLine[];
}): JSX.Element {
  const { t, lang } = useT();
  const [filter, setFilter] = useState<ChangeFilter>("all");
  const both = news.length > 0 && fixes.length > 0;
  const shown: ChangeFilter = both ? filter : news.length > 0 ? "news" : "fixes";
  const options: { value: ChangeFilter; label: string; count: number }[] = [
    { value: "all", label: t("shell.update.filterAll"), count: news.length + fixes.length },
    { value: "news", label: t("shell.update.tabNews"), count: news.length },
    { value: "fixes", label: t("shell.update.tabFixes"), count: fixes.length },
  ];

  return (
    <div className="flex min-h-0 flex-col">
      <div className={PANE_TOP}>
        {both ? (
          // A radio group: one tab stop, the arrow keys move the choice.
          <SegmentedControl
            render={
              <RadioGroupPrimitive
                aria-label={t("shell.update.filter")}
                onValueChange={(value) => setFilter(value as ChangeFilter)}
                value={filter}
              />
            }
            size="sm"
          >
            {options.map((option) => (
              <SegmentedControlItem
                className="gap-1.5"
                key={option.value}
                render={<RadioPrimitive.Root value={option.value} />}
              >
                {option.label}
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatNumber(option.count, lang)}
                </span>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        ) : (
          <h3 className="font-semibold text-heading">
            {shown === "news" ? t("shell.update.tabNews") : t("shell.update.tabFixes")}
          </h3>
        )}
      </div>
      <ScrollArea className={PANE_SCROLL} overscrollContain scrollFade>
        <div className={cn(PANE_CONTENT, "flex flex-col gap-5")}>
          {shown !== "fixes" ? (
            <ChangeGroup
              icon={SparklesIcon}
              label={shown === "all" ? t("shell.update.tabNews") : undefined}
              lines={news}
            />
          ) : null}
          {shown !== "news" ? (
            <ChangeGroup
              icon={WrenchIcon}
              label={shown === "all" ? t("shell.update.tabFixes") : undefined}
              lines={fixes}
            />
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

/** One list of changes, under a small label with its icon when All shows both lists. */
function ChangeGroup({
  icon,
  label,
  lines,
}: {
  icon: typeof SparklesIcon;
  label?: string;
  lines: ChangelogLine[];
}): JSX.Element {
  const id = useId();
  if (!label) return <ChangeList lines={lines} />;
  return (
    <div className="flex flex-col gap-2.5">
      <p className="flex items-center gap-1.5 font-medium text-meta text-muted-foreground" id={id}>
        <HugeiconsIcon aria-hidden="true" className="size-3.5" icon={icon} />
        {label}
      </p>
      <ChangeList labelledBy={id} lines={lines} />
    </div>
  );
}

/**
 * A list, one change per line: the release's emoji as the marker (a dot when the line has none),
 * 14 px text with room between items, and a remaining tag such as "New:" in medium weight.
 */
function ChangeList({
  lines,
  labelledBy,
}: {
  lines: ChangelogLine[];
  /** The label the list sits under, when All shows both lists. */
  labelledBy?: string;
}): JSX.Element {
  return (
    <ul aria-labelledby={labelledBy} className="flex flex-col gap-2.5">
      {lines.map((line) => (
        <li className="flex gap-2.5 text-sm leading-relaxed" key={line.key}>
          <span
            aria-hidden="true"
            className="flex h-lh w-5 shrink-0 items-center justify-center leading-relaxed"
          >
            {line.marker ?? <span className="size-1.5 rounded-full bg-muted-foreground" />}
          </span>
          <span className="min-w-0 text-pretty wrap-break-word text-foreground/90">
            {line.tag ? <span className="font-medium text-foreground">{line.tag} </span> : null}
            {line.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

const UPDATE_METHODS = [
  { id: "compose", label: "shell.update.methodCompose", hint: "shell.update.composeHint" },
  { id: "image", label: "shell.update.methodImage", hint: "shell.update.imageHint" },
  { id: "binary", label: "shell.update.methodBinary", hint: null },
] as const satisfies readonly { id: UpdateMethod; label: string; hint: string | null }[];

/**
 * The three ways to update as radio cards, opening on the one that fits this server
 * (preferredMethod, marked Recommended once the server has said what it runs on), then that
 * way's steps. The binary steps name the archive for the server's own platform, which may not be
 * the browser's; its card says which.
 */
function HowToUpdate({
  heading,
  latest,
  server,
}: {
  /** Shows "How to update" over the cards (a phone's tab already says it). */
  heading: boolean;
  latest: string;
  server?: VersionResponse;
}): JSX.Element {
  const { t } = useT();
  const preferred = preferredMethod(server);
  const [method, setMethod] = useState<UpdateMethod>(preferred);
  const archive = releaseArchive(server);
  // Only a server that reported its platform or container gets a recommendation.
  const reported = Boolean(server?.docker || server?.os);
  const env = { env: "DATA_DIR" };
  const reload = t("shell.update.reload", { latest });

  let steps: UpdateStep[];
  if (method === "compose") {
    steps = [
      { key: "open", body: t("shell.update.composeOpen") },
      {
        key: "run",
        body: <CommandStep command={COMPOSE_COMMAND} text={t("shell.update.composeRun")} />,
      },
      { key: "reload", body: reload },
    ];
  } else if (method === "image") {
    steps = [
      {
        key: "pull",
        body: <CommandStep command={IMAGE_COMMAND} text={t("shell.update.imageStep")} />,
      },
      { key: "recreate", body: t("shell.update.imageRecreate") },
      { key: "reload", body: reload },
    ];
  } else {
    const download = archive.windows
      ? "shell.update.binaryDownloadWindows"
      : "shell.update.binaryDownload";
    steps = [
      { key: "stop", body: t("shell.update.binaryStop") },
      {
        key: "download",
        body: (
          <CommandStep
            command={binaryCommand(archive)}
            text={
              <CodeText
                code={{ folder: archive.folder }}
                text={t(download, { platform: t(archive.platformLabel) })}
              />
            }
          />
        ),
      },
      {
        key: "start",
        body: (
          <>
            <p>
              <CodeText code={env} text={t("shell.update.binaryStart")} />
            </p>
            <p className="text-pretty text-muted-foreground text-xs leading-normal">
              <CodeText code={env} text={t("shell.update.binaryNoEnv")} />
              {archive.known ? null : <> {t("shell.update.binaryOther")}</>}
            </p>
          </>
        ),
      },
    ];
  }

  return (
    <>
      {heading ? (
        <div className={PANE_TOP}>
          <h3 className="font-semibold text-heading">{t("shell.update.howTo")}</h3>
        </div>
      ) : null}
      <ScrollArea className={PANE_SCROLL} overscrollContain scrollFade>
        <div className={cn(PANE_CONTENT, "flex flex-col gap-5", !heading && "pt-4")}>
          <RadioGroup
            aria-label={t("shell.update.method")}
            className="gap-2"
            onValueChange={(value) => setMethod(value as UpdateMethod)}
            value={method}
          >
            {UPDATE_METHODS.map((item) => (
              <ChoiceCard
                control={(id) => <Radio id={id} value={item.id} />}
                description={item.hint ? t(item.hint) : t(archive.platformLabel)}
                key={item.id}
                title={
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {t(item.label)}
                    {reported && item.id === preferred ? (
                      <Badge size="sm" tone="primary">
                        {t("shell.update.recommended")}
                      </Badge>
                    ) : null}
                  </span>
                }
              />
            ))}
          </RadioGroup>
          <UpdateSteps steps={steps} />
        </div>
      </ScrollArea>
    </>
  );
}

interface UpdateStep {
  key: string;
  /** The step's sentence, and anything it needs (a command to copy). */
  body: ReactNode;
}

/**
 * Numbered steps, each a ring with its number joined to the next by a hairline (the add account
 * flow's steps), then the step's sentence and anything it needs.
 */
function UpdateSteps({ steps }: { steps: UpdateStep[] }): JSX.Element {
  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <li className="flex gap-3.5" key={step.key}>
            <span aria-hidden="true" className="flex flex-col items-center">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border font-semibold text-meta text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              {last ? null : <span className="mt-1.5 w-px flex-1 bg-border" />}
            </span>
            <div
              className={cn(
                "flex min-w-0 flex-1 flex-col gap-2 pt-0.5 text-pretty text-foreground/90 text-sm leading-relaxed",
                !last && "pb-5",
              )}
            >
              {step.body}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** A step's sentence, then the command it names, as one highlighted line to copy. */
function CommandStep({ text, command }: { text: ReactNode; command: string }): JSX.Element {
  const id = useId();
  return (
    <>
      <p id={id}>{text}</p>
      <CopyField labelledBy={id} language="bash" value={command} />
    </>
  );
}
