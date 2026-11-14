import { ArrowRight02Icon, ExternalLinkIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useMemo, useState } from "react";
import { CopyField } from "@/components/shared/code-field";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { CodeText } from "@/features/api/code-text";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { RemoteVersionJson, VersionResponse } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { keyByText } from "@/lib/utils";
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
const UPDATE_METHODS = [
  { id: "compose", label: "shell.update.methodCompose" },
  { id: "image", label: "shell.update.methodImage" },
  { id: "binary", label: "shell.update.methodBinary" },
] as const satisfies readonly { id: UpdateMethod; label: string }[];

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
  // Phones set no tab height (TabBody), so a centred dialog would grow and shrink round its
  // middle on a tab switch and move the tab strip under the finger. Top-anchored, it fills the
  // 90dvh box and stays put. From sm up every tab is one height, so it stays centred.
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
      <UpdateTabs changelog={latest?.changelog} server={server} />
    </ResponsiveDialog>
  );
}

type UpdateTab = "news" | "fixes" | "how";

/**
 * A tab's body. One fixed height for every tab from sm up, so the dialog and its footer stay put
 * on a switch; a long list scrolls inside the dialog's own scroll box (ScrollArea, as DialogPanel),
 * fading at the edge it can still scroll past. Phones set no height: the list shows whole and the
 * dialog's panel scrolls instead (90dvh), so there is no scroller inside a scroller, and no cut
 * that falls between two items unseen. flex-none: the panel's flex-1 basis would win over the
 * height. The scroll box is the tab stop (Base UI makes it one while it overflows), so the panel
 * is not one too; the scroll-fade-y utility stays off the panel, since Base UI waits for a
 * panel's animations to end before it removes it, and that scroll-driven one never ends.
 */
function TabBody({ value, children }: { value: UpdateTab; children: JSX.Element }): JSX.Element {
  return (
    <TabsPanel className="sm:h-95 sm:flex-none" tabIndex={-1} value={value}>
      {/* 8 px of room at the end, borrowed from the dialog's padding: a copy field's button
          box reaches 7 px past the field (input-group -me-2), and the scroll box would clip it. */}
      <ScrollArea className="-me-2 w-auto" overscrollContain scrollFade>
        <div className="pe-2">{children}</div>
      </ScrollArea>
    </TabsPanel>
  );
}

/**
 * New, Fixes and How to update as underlined tabs (the API page's Client setup tabs),
 * each list with its count. A tab with nothing in it is left out, and How to update alone shows
 * without a tab strip.
 */
function UpdateTabs({
  changelog,
  server,
}: {
  changelog: string | undefined;
  server?: VersionResponse;
}): JSX.Element {
  const { t, lang } = useT();
  const { news, fixes } = useMemo(() => splitChangelog(changelog), [changelog]);
  const tabs = [
    ...(news.length > 0
      ? [{ value: "news" as const, label: t("shell.update.tabNews"), count: news.length }]
      : []),
    ...(fixes.length > 0
      ? [{ value: "fixes" as const, label: t("shell.update.tabFixes"), count: fixes.length }]
      : []),
    { value: "how" as const, label: t("shell.update.howTo"), count: undefined },
  ];
  const [tab, setTab] = useState<UpdateTab>(tabs[0]?.value ?? "how");

  if (tabs.length === 1) return <HowToUpdate server={server} />;
  return (
    <Tabs className="gap-4" onValueChange={(value) => setTab(value as UpdateTab)} value={tab}>
      <TabsList aria-label={t("shell.update.title")} variant="underline">
        {tabs.map((item) => (
          <TabsTab key={item.value} value={item.value}>
            {item.label}
            {item.count === undefined ? null : (
              <Badge
                className="min-w-5"
                size="sm"
                tone={item.value === tab ? "primary" : "neutral"}
              >
                {formatNumber(item.count, lang)}
              </Badge>
            )}
          </TabsTab>
        ))}
      </TabsList>
      {news.length > 0 ? (
        <TabBody value="news">
          <ChangeList lines={news} />
        </TabBody>
      ) : null}
      {fixes.length > 0 ? (
        <TabBody value="fixes">
          <ChangeList lines={fixes} />
        </TabBody>
      ) : null}
      <TabBody value="how">
        <HowToUpdate server={server} />
      </TabBody>
    </Tabs>
  );
}

/**
 * A list, one change per line: the release's emoji as the marker (a dot when the line has none),
 * 14 px text with room between items, and a remaining tag such as "New:" in medium weight.
 */
function ChangeList({ lines }: { lines: ChangelogLine[] }): JSX.Element {
  return (
    <ul className="flex flex-col gap-2.5">
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

/**
 * The three ways to update, in a segmented control that opens on the one that fits this server
 * (preferredMethod); the binary steps name the archive for the server's own platform, which may
 * not be the browser's.
 */
function HowToUpdate({ server }: { server?: VersionResponse }): JSX.Element {
  const { t } = useT();
  const [method, setMethod] = useState<UpdateMethod>(() => preferredMethod(server));
  const archive = releaseArchive(server);
  // Windows runs the command in PowerShell; the step says so.
  const binaryStep = archive.windows ? "shell.update.binaryStepWindows" : "shell.update.binaryStep";
  const env = { env: "DATA_DIR" };

  return (
    <div className="flex flex-col gap-4">
      {/* A radio group: one tab stop, the arrow keys move the choice. */}
      <SegmentedControl
        render={
          <RadioGroupPrimitive
            aria-label={t("shell.update.method")}
            onValueChange={(value) => setMethod(value as UpdateMethod)}
            value={method}
          />
        }
        size="sm"
      >
        {UPDATE_METHODS.map((item) => (
          <SegmentedControlItem key={item.id} render={<RadioPrimitive.Root value={item.id} />}>
            {t(item.label)}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      {method === "compose" ? (
        <UpdateStep command={COMPOSE_COMMAND}>{t("shell.update.composeStep")}</UpdateStep>
      ) : method === "image" ? (
        <UpdateStep after={t("shell.update.imageAfter")} command={IMAGE_COMMAND}>
          {t("shell.update.imageStep")}
        </UpdateStep>
      ) : (
        <UpdateStep
          after={
            <>
              <CodeText code={env} text={t("shell.update.binaryAfter")} />
              {archive.known ? null : <> {t("shell.update.binaryOther")}</>}
            </>
          }
          command={binaryCommand(archive)}
        >
          <CodeText
            code={{ folder: archive.folder }}
            text={t(binaryStep, { platform: t(archive.platformLabel) })}
          />
        </UpdateStep>
      )}
    </div>
  );
}

/** A sentence, the command to copy (named by that sentence) and an optional note under it. */
function UpdateStep({
  children,
  command,
  after,
}: {
  children: JSX.Element | string;
  command: string;
  after?: JSX.Element | string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-pretty text-foreground/90 text-sm leading-relaxed" id="update-step">
        {children}
      </p>
      <CopyField labelledBy="update-step" multiline value={command} />
      {after ? (
        <p className="text-pretty text-muted-foreground text-xs leading-normal">{after}</p>
      ) : null}
    </div>
  );
}
