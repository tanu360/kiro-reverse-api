import {
  AlertCircleIcon,
  ArrowRight02Icon,
  CheckmarkCircle02Icon,
  Download04Icon,
  ExternalLinkIcon,
  InformationCircleIcon,
  ReloadIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, type ReactNode, useId, useMemo, useState } from "react";
import { ChoiceCard } from "@/components/shared/choice-card";
import { CopyField } from "@/components/shared/code-field";
import { IconChip } from "@/components/shared/icon-chip";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { CodeText } from "@/features/api/code-text";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { RemoteVersionJson, VersionResponse } from "@/lib/api/types";
import type { UpdateStatus } from "@/lib/api/update";
import { formatBytes, formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn, keyByText } from "@/lib/utils";
import type { SelfUpdate } from "./self-update";
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

type UpdateMethod = "compose" | "image" | "binary";

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
 * The changelog as one plain list in its own order, without the "New:" or "Fixed:" tags (the
 * dialog does not sort changes into kinds); a tagged line starts with a capital once its tag is
 * gone.
 */
export function plainChangelog(changelog: string | undefined): ChangelogLine[] {
  return parseChangelog(changelog ?? "").map((line) =>
    line.tag ? { ...line, tag: null, text: capitalizeFirst(line.text) } : line,
  );
}

interface ReleaseArchive {
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
  selfUpdate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string;
  latest: RemoteVersionJson | null;
  /** GET /admin/api/version: the server's platform and whether it runs in a container. */
  server?: VersionResponse;
  /** The download-and-restart flow, for a server that installs releases itself (self-update.tsx). */
  selfUpdate?: SelfUpdate;
}): JSX.Element {
  const { t } = useT();
  const download = latest?.download ?? "";
  // Only an https link from the remote file is followed; otherwise the repository.
  const projectUrl = download.startsWith("https://") ? download : GITHUB_URL;
  const next = latest?.version ? stripV(latest.version) : "";
  const changes = useMemo(() => plainChangelog(latest?.changelog), [latest?.changelog]);
  // Phones: top-anchored, the dialog fills the 90dvh box whatever it shows. From sm up the body
  // has one fixed height. Either way no method or download state changes the dialog's height:
  // the body scrolls instead.
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
      size="lg"
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
      <UpdateBody
        changes={changes}
        latest={next}
        releaseUrl={projectUrl}
        selfUpdate={selfUpdate}
        server={server}
      />
    </ResponsiveDialog>
  );
}

/*
 * The body under the header: a hairline, then one scroll box of one fixed height from sm up
 * (544 px, room for the changes and the download without scrolling), so the dialog never grows
 * or shrinks with a method or the download's state; on phones it takes what the 90dvh dialog
 * leaves. On a screen too short for 544 px it shrinks (flex-initial) and scrolls, so the footer
 * stays on screen.
 */
const BODY = "min-h-0 flex-1 border-border-subtle border-t sm:h-136 sm:flex-initial";

/** How many changes the dialog lists, each at most two lines; the rest are on the release page. */
const PREVIEW_LINES = 3;

/** In a container only the Docker ways apply: the binary would be lost with the container. */
const DOCKER_METHODS: readonly UpdateMethod[] = ["compose", "image"];

/**
 * One simple page: a few of the release's changes with a link to all of them, then the update
 * itself. A server that installs releases itself gets the download and the restart, with the
 * steps by hand one link away; any other gets the steps: in a container only the Docker ways,
 * and for a binary that cannot write its own folder, a note that says so.
 */
function UpdateBody({
  changes,
  latest,
  releaseUrl,
  server,
  selfUpdate,
}: {
  changes: ChangelogLine[];
  /** The new version, for the step that says what the sidebar shows after the update. */
  latest: string;
  /** The release page on GitHub, where every change is listed. */
  releaseUrl: string;
  server?: VersionResponse;
  selfUpdate?: SelfUpdate;
}): JSX.Element {
  const { t } = useT();
  const howId = useId();
  return (
    <ScrollArea className={BODY} overscrollContain scrollFade>
      <div className="flex flex-col gap-5 px-6 pt-4 pb-5 max-sm:px-4">
        {changes.length > 0 ? <ChangesPreview changes={changes} releaseUrl={releaseUrl} /> : null}
        <section aria-labelledby={howId} className="flex flex-col gap-3">
          <h3 className="font-semibold text-heading" id={howId}>
            {t("shell.update.howTo")}
          </h3>
          {!server?.docker && selfUpdate?.available ? (
            <SelfUpdatePane latest={latest} server={server} update={selfUpdate} />
          ) : (
            <HowToUpdate
              latest={latest}
              methods={server?.docker ? DOCKER_METHODS : undefined}
              notice={<UnsupportedNotice status={selfUpdate?.status} />}
              server={server}
            />
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

/** The first few changes as they come, then a link to every change on the release page. */
function ChangesPreview({
  changes,
  releaseUrl,
}: {
  changes: ChangelogLine[];
  releaseUrl: string;
}): JSX.Element {
  const { t, lang } = useT();
  const id = useId();
  const more = changes.length > PREVIEW_LINES;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h3 className="font-semibold text-heading" id={id}>
        {t("shell.update.changesTitle")}
      </h3>
      <ChangeList clamp labelledBy={id} lines={changes.slice(0, PREVIEW_LINES)} />
      <p className="text-sm">
        <Button
          render={<a href={releaseUrl} rel="noopener noreferrer" target="_blank" />}
          variant="link-action"
        >
          {more
            ? t("shell.update.seeAll", { count: formatNumber(changes.length, lang) })
            : t("shell.update.viewRelease")}
          <HugeiconsIcon aria-hidden="true" icon={ExternalLinkIcon} />
        </Button>
      </p>
    </section>
  );
}

/** Why a binary install updates by hand: its folder is read-only, or no archive fits it. */
function UnsupportedNotice({ status }: { status?: UpdateStatus }): JSX.Element | null {
  const { t } = useT();
  if (status?.reason !== "not_writable" && status?.reason !== "platform") return null;
  return (
    <Alert role="note" variant="info">
      <HugeiconsIcon aria-hidden="true" icon={InformationCircleIcon} />
      <AlertDescription className="wrap-break-word">
        {/* One paragraph, so the path runs inline: the description lays its children out as a column. */}
        <p>
          {status.reason === "not_writable" ? (
            <CodeText
              code={{ path: status.path ?? "kiro-proxy" }}
              text={t("shell.update.notWritable")}
            />
          ) : (
            t("shell.update.noPlatform")
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The update on a server that installs releases itself: the release for this server's platform,
 * one button that downloads and checks it, its progress, then one button that restarts on it.
 * The steps by hand stay one link away.
 */
function SelfUpdatePane({
  latest,
  server,
  update,
}: {
  latest: string;
  server?: VersionResponse;
  update: SelfUpdate;
}): JSX.Element {
  const { t } = useT();
  const [manual, setManual] = useState(false);
  if (manual) {
    return (
      <HowToUpdate
        footer={
          <p className="text-sm">
            <Button onClick={() => setManual(false)} variant="link-action">
              {t("shell.update.automatic")}
            </Button>
          </p>
        }
        latest={latest}
        server={server}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <SelfUpdateCard latest={latest} server={server} update={update} />
      {update.phase === "restarting" ? null : (
        <p className="text-sm">
          <Button onClick={() => setManual(true)} variant="link-action">
            {t("shell.update.manual")}
          </Button>
        </p>
      )}
    </div>
  );
}

/** The release to install, then what the update is doing and the one action that fits. */
function SelfUpdateCard({
  latest,
  server,
  update,
}: {
  latest: string;
  server?: VersionResponse;
  update: SelfUpdate;
}): JSX.Element {
  const { t, lang } = useT();
  const archive = releaseArchive(server);
  const status = update.status;
  const platform = t(archive.platformLabel);

  let body: ReactNode;
  switch (update.phase) {
    case "starting":
    case "downloading": {
      const { downloaded, total, progress } = status ?? {};
      const amount =
        total !== undefined && progress !== undefined
          ? t("shell.update.downloadedOf", {
              downloaded: formatBytes(downloaded ?? 0, lang),
              total: formatBytes(total, lang),
              percent: progress,
            })
          : undefined;
      body = (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
            <span className="inline-flex items-baseline gap-1.5 font-medium text-foreground">
              <Spinner aria-hidden="true" className="size-3 self-center" />
              {t("shell.update.downloading")}
            </span>
            {amount ? <span className="text-muted-foreground tabular-nums">{amount}</span> : null}
          </div>
          <Meter
            aria-label={t("shell.update.progressLabel")}
            getAriaValueText={() => amount ?? t("shell.update.downloading")}
            value={progress ?? 0}
          >
            <MeterTrack className="h-1.5">
              <MeterIndicator />
            </MeterTrack>
          </Meter>
          <p className="text-muted-foreground text-xs leading-normal">
            {t("shell.update.downloadNote")}
          </p>
        </div>
      );
      break;
    }
    case "ready":
      body = (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="inline-flex items-center gap-1.5 font-medium text-sm text-success-foreground">
              <HugeiconsIcon aria-hidden="true" className="size-4" icon={CheckmarkCircle02Icon} />
              {t("shell.update.readyTitle")}
            </p>
            <p className="text-pretty text-muted-foreground text-sm leading-relaxed">
              {t("shell.update.readyBody", { latest })}
            </p>
          </div>
          <Button className="w-full" onClick={update.restart}>
            <HugeiconsIcon aria-hidden="true" icon={ReloadIcon} />
            {t("shell.update.restart")}
          </Button>
          <p className="text-pretty text-muted-foreground text-xs leading-normal">
            {t("shell.update.restartNote")}
          </p>
        </div>
      );
      break;
    case "restarting":
      body = (
        <div className="flex flex-col gap-1">
          <p className="inline-flex items-center gap-1.5 font-medium text-foreground text-sm">
            <Spinner aria-hidden="true" className="size-3.5" />
            {t("shell.update.restarting")}
          </p>
          <p className="text-pretty text-muted-foreground text-sm leading-relaxed">
            {t("shell.update.restartingNote", { latest })}
          </p>
        </div>
      );
      break;
    case "error":
      body = (
        <div className="flex flex-col gap-3">
          {/* One plain line: the reason (the card says it failed); the title only without one.
              No alert role: the self-update reads the failure out once, wherever it shows. */}
          <Alert role="note" variant="error">
            <HugeiconsIcon aria-hidden="true" icon={AlertCircleIcon} />
            <AlertDescription className="wrap-break-word">
              {update.error ?? t("shell.update.failedTitle")}
            </AlertDescription>
          </Alert>
          <Button className="w-full" onClick={update.start} variant="outline">
            <HugeiconsIcon aria-hidden="true" icon={Download04Icon} />
            {t("shell.update.retry")}
          </Button>
        </div>
      );
      break;
    default:
      body = (
        <div className="flex flex-col gap-3">
          <p className="text-pretty text-muted-foreground text-xs leading-normal">
            {t("shell.update.autoIntro", { platform })}
          </p>
          <Button className="w-full" onClick={update.start}>
            <HugeiconsIcon aria-hidden="true" icon={Download04Icon} />
            {t("shell.update.download")}
          </Button>
        </div>
      );
  }

  return (
    <Card className="gap-4" data-phase={update.phase} data-slot="self-update-card" size="sm">
      <div className="flex items-center gap-3">
        <IconChip icon={Download04Icon} size="md" />
        <div className="flex min-w-0 flex-col">
          <p className="font-medium text-foreground text-sm">
            {t("shell.update.cardTitle", { latest })}
          </p>
          <p className="truncate text-muted-foreground text-xs">
            {platform} · {archive.file}
          </p>
        </div>
      </div>
      {body}
    </Card>
  );
}

/**
 * A list, one change per line: the release's emoji as the marker (a dot when the line has none),
 * 14 px text with room between items, and a remaining tag such as "New:" in medium weight.
 */
function ChangeList({
  lines,
  labelledBy,
  clamp = false,
}: {
  lines: ChangelogLine[];
  /** The heading the list sits under. */
  labelledBy?: string;
  /** At most two lines a change (the dialog's short list; the release page has them whole). */
  clamp?: boolean;
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
          <span
            className={cn(
              "min-w-0 text-pretty wrap-break-word text-foreground/90",
              clamp && "line-clamp-2",
            )}
          >
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
  latest,
  server,
  methods,
  notice,
  footer,
}: {
  latest: string;
  server?: VersionResponse;
  /** The ways to offer; all three by default. */
  methods?: readonly UpdateMethod[];
  /** A note over the cards (why this server does not update itself). */
  notice?: ReactNode;
  /** After the steps (the link back to the automatic update). */
  footer?: ReactNode;
}): JSX.Element {
  const { t } = useT();
  const offered = UPDATE_METHODS.filter((item) => !methods || methods.includes(item.id));
  const preferred = preferredMethod(server);
  const [method, setMethod] = useState<UpdateMethod>(
    offered.some((item) => item.id === preferred) ? preferred : (offered[0]?.id ?? "compose"),
  );
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
    <div className="flex flex-col gap-5">
      {notice}
      <RadioGroup
        aria-label={t("shell.update.method")}
        className="gap-2"
        onValueChange={(value) => setMethod(value as UpdateMethod)}
        value={method}
      >
        {offered.map((item) => (
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
      {footer}
    </div>
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
