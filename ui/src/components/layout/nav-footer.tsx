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
 * Old footer items: version badge with update notice, "Running" status, GitHub link,
 * tagline and copyright, then the Admin user row. In the icon rail they collapse into one
 * info tooltip.
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
      <div className="flex flex-col gap-2 px-2 pb-1 text-xs group-data-[collapsible=icon]:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <VersionBadge className="max-lg:h-10 max-lg:px-3" />
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden="true" className="size-2 rounded-full bg-success" />
            {t("shell.running")}
          </span>
          <a
            className="ms-auto inline-flex items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-lg:min-h-10 max-lg:px-2"
            href={GITHUB_URL}
            rel="noopener"
            target="_blank"
          >
            {t("shell.github")}
            <ExternalLinkIcon aria-hidden="true" className="size-3" />
          </a>
        </div>
        <p className="text-muted-foreground leading-snug">{t("shell.tagline")}</p>
        <p className="text-muted-foreground">
          {copyright} · {t("shell.builtFor")}
        </p>
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
            tooltip={[updateLabel, `${t("shell.running")} · ${copyright} · ${t("shell.builtFor")}`]
              .filter(Boolean)
              .join(" · ")}
          >
            <InfoIcon aria-hidden="true" />
            <span>{t("shell.about")}</span>
            {latest ? <UpdateDot className="top-1 right-1 ring-sidebar" /> : null}
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
