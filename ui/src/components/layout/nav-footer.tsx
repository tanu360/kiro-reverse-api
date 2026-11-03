import { ExternalLinkIcon, InfoIcon } from "lucide-react";
import type { JSX } from "react";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useT } from "@/lib/i18n";
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

  return (
    <>
      <div className="flex flex-col gap-2 px-2 pb-1 text-xs group-data-[collapsible=icon]:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <VersionBadge />
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden="true" className="size-2 rounded-full bg-success" />
            {t("shell.running")}
          </span>
          <a
            className="ms-auto inline-flex items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            href={GITHUB_URL}
            rel="noopener"
            target="_blank"
          >
            {t("shell.github")}
            <ExternalLinkIcon aria-hidden="true" className="size-3" />
          </a>
        </div>
        <p className="text-muted-foreground leading-snug">{t("shell.tagline")}</p>
        <p className="text-muted-foreground/80">
          {copyright} · {t("shell.builtFor")}
        </p>
      </div>
      <SidebarMenu className="hidden group-data-[collapsible=icon]:flex">
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label={t("shell.about")}
            tooltip={`${t("shell.running")} · ${copyright} · ${t("shell.builtFor")}`}
          >
            <InfoIcon aria-hidden="true" />
            <span>{t("shell.about")}</span>
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
