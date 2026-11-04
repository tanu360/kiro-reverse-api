import { ExternalLinkIcon, InfoIcon } from "lucide-react";
import type { JSX } from "react";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useT } from "@/lib/i18n";
import { UpdateDot, useUpdateCheck } from "./update-check";
import { stripV } from "./update-dialog";
import { UserMenu } from "./user-menu";
import { VersionBadge } from "./version-badge";

export const GITHUB_URL = "https://github.com/tanu360/kiro-reverse-api";

/**
 * Old footer items: version badge with update notice, "Running" status, GitHub link and the
 * copyright, then the Admin user row. In the icon rail they collapse into one info tooltip.
 * Quiet like the sign-in footer: 12 px meta in one row, then the copyright line as the sign-in
 * pages draw it (13 px, a middle dot before the app name), in the sidebar's muted text
 * colour as t3code's sidebar footer.
 */
export function NavFooter(): JSX.Element {
  const { t } = useT();
  const year = new Date().getFullYear();
  const copyright = t("shell.copyright", { year });
  const { latest, openDialog } = useUpdateCheck();
  const updateLabel = latest
    ? t("shell.update.available", { latest: stripV(latest.version) })
    : null;

  return (
    <>
      <div className="flex flex-col gap-2.5 px-2 pb-1 text-xs group-data-[collapsible=icon]:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <VersionBadge className="max-lg:h-10 max-lg:px-3" />
          <span className="inline-flex items-center gap-1.5 text-sidebar-muted-foreground">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
            {t("shell.running")}
          </span>
          <a
            className="ms-auto inline-flex items-center gap-1 rounded-sm text-sidebar-muted-foreground outline-none transition-colors hover:text-sidebar-foreground focus-outline max-lg:min-h-10 max-lg:px-2"
            href={GITHUB_URL}
            rel="noopener"
            target="_blank"
          >
            {t("shell.github")}
            <ExternalLinkIcon aria-hidden="true" className="size-3" />
          </a>
        </div>
        <FooterCopyright line={copyright} />
      </div>
      <SidebarMenu className="hidden group-data-[collapsible=icon]:flex">
        <SidebarMenuItem>
          {/* In the rail the version badge is hidden, so a newer release marks this button. */}
          <SidebarMenuButton
            aria-label={
              updateLabel
                ? t("a11y.labelWithDetail", { label: t("shell.about"), detail: updateLabel })
                : t("shell.about")
            }
            className="relative"
            onClick={latest ? openDialog : undefined}
            tooltip={[updateLabel, `${t("shell.running")} · ${copyright}`]
              .filter(Boolean)
              .join(" · ")}
          >
            <InfoIcon aria-hidden="true" />
            <span>{t("shell.about")}</span>
            {latest ? <UpdateDot className="top-1 right-1 outline-sidebar" /> : null}
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <SidebarMenu>
        <SidebarMenuItem>
          <UserMenu variant="sidebar" />
        </SidebarMenuItem>
      </SidebarMenu>
    </>
  );
}

/**
 * "© 2026 · Kiro Proxy", as on the sign-in pages: all in the muted text colour, with a middle
 * dot before the name. The line is split at the app name, so a locale keeps its own word
 * order; the dot is decoration and hidden from screen readers.
 */
function FooterCopyright({ line }: { line: string }): JSX.Element {
  const { t } = useT();
  const name = t("shell.appName");
  const at = line.lastIndexOf(name);
  return (
    <p className="text-[13px] text-sidebar-muted-foreground tabular-nums">
      {at < 0 ? (
        line
      ) : (
        <>
          {line.slice(0, at).trimEnd()}
          <span aria-hidden="true" className="mx-1.5">
            ·
          </span>
          <span>{name}</span>
          {line.slice(at + name.length)}
        </>
      )}
    </p>
  );
}
