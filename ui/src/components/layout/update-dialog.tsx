import { ArrowRight02Icon, ExternalLinkIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";
import { ResponsiveDialog } from "@/components/shared/responsive-dialog";
import { Button } from "@/components/ui/button";
import type { RemoteVersionJson } from "@/lib/api/types";
import { useT } from "@/lib/i18n";

/** "v2.1.0" and "2.1.0" both display as "2.1.0"; the UI adds its own "v". */
export function stripV(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** A leading emoji (with its variation selector or ZWJ sequence), used as the line's marker. */
const LEADING_EMOJI = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u;
/** A markdown or typed bullet, dropped: the list draws its own marker. */
const LEADING_BULLET = /^[-*•]\s+/;
/** "New:", "Fixed:" and the like, set in medium weight. */
const LEADING_TAG = /^((?:new|fixed|fix|changed|improved|removed|breaking|security)\s*:)\s*/i;

export interface ChangelogLine {
  marker: string | null;
  tag: string | null;
  text: string;
}

/** One list item per non-empty changelog line: its emoji marker, a "Fixed:" tag, the text. */
export function parseChangelog(changelog: string): ChangelogLine[] {
  return changelog
    .split(/\r?\n/)
    .map((line) => line.trim().replace(LEADING_BULLET, ""))
    .filter(Boolean)
    .map((line) => {
      const emoji = LEADING_EMOJI.exec(line);
      const rest = emoji ? line.slice(emoji[0].length) : line;
      const tag = LEADING_TAG.exec(rest);
      return {
        marker: emoji ? emoji[1] : null,
        tag: tag ? tag[1] : null,
        text: tag ? rest.slice(tag[0].length) : rest,
      };
    });
}

export function UpdateDialog({
  open,
  onOpenChange,
  current,
  latest,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string;
  latest: RemoteVersionJson | null;
}): JSX.Element {
  const { t } = useT();
  const download = latest?.download ?? "";
  // Only an https release link is offered; anything else in the remote file is ignored.
  const releaseUrl = download.startsWith("https://") ? download : null;
  const changelog = latest?.changelog?.trim();

  return (
    <ResponsiveDialog
      description={t("shell.update.newVersionMessage")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            {t("actions.close")}
          </Button>
          {releaseUrl ? (
            <Button render={<a href={releaseUrl} rel="noopener noreferrer" target="_blank" />}>
              {t("shell.update.viewRelease")}
              <HugeiconsIcon icon={ExternalLinkIcon} aria-hidden="true" />
            </Button>
          ) : null}
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      title={t("shell.update.title")}
    >
      <div className="flex flex-col gap-5">
        {/* One strip, read left to right: the running version, an arrow, the new one in purple. */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 rounded-[var(--control-radius)] border border-border/60 bg-muted/40 px-4 py-3">
          <VersionCell label={t("shell.update.current")} value={current} />
          <HugeiconsIcon
            aria-hidden="true"
            className="size-4 text-muted-foreground"
            icon={ArrowRight02Icon}
          />
          <VersionCell highlight label={t("shell.update.latest")} value={latest?.version ?? ""} />
        </div>
        {changelog ? (
          <section aria-labelledby="update-changelog" className="flex min-h-0 flex-col gap-2.5">
            <h3 className="font-medium text-sm" id="update-changelog">
              {t("shell.update.changelog")}
            </h3>
            {/* A list, one change per line: the release's emoji as the marker (a dot when the
                line has none), 14 px text with room between items; scrolls past 18rem. */}
            <ul className="scroll-fade-y -me-2 flex max-h-72 flex-col gap-2.5 overflow-y-auto pe-2">
              {parseChangelog(changelog).map((line, index) => (
                <li
                  className="flex gap-2.5 text-sm leading-relaxed"
                  // biome-ignore lint/suspicious/noArrayIndexKey: changelog lines are static text and may repeat.
                  key={index}
                >
                  <span
                    aria-hidden="true"
                    className="flex h-[1.625em] w-5 shrink-0 items-center justify-center"
                  >
                    {line.marker ?? (
                      <span className="size-1.5 rounded-full bg-muted-foreground/50" />
                    )}
                  </span>
                  <span className="min-w-0 text-pretty break-words text-foreground/90">
                    {line.tag ? (
                      <span className="font-medium text-foreground">{line.tag} </span>
                    ) : null}
                    {line.text}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </ResponsiveDialog>
  );
}

/** "Current" over "v2.1.0": a muted label over the version, purple for the new one. */
function VersionCell({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}): JSX.Element {
  return (
    <div
      className={
        highlight ? "flex min-w-0 flex-col items-end gap-0.5" : "flex min-w-0 flex-col gap-0.5"
      }
    >
      <span className="text-muted-foreground text-xs">{label}</span>
      <span
        className={
          highlight
            ? "truncate font-semibold text-base text-info-foreground tabular-nums"
            : "truncate font-semibold text-base tabular-nums"
        }
      >
        {value ? `v${stripV(value)}` : "—"}
      </span>
    </div>
  );
}
