import {
  ArchiveIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  type LucideIcon,
  PlugIcon,
  SlidersHorizontalIcon,
  UsersIcon,
} from "lucide-react";

export interface NavItem {
  id: "overview" | "accounts" | "requests" | "api" | "backups" | "settings";
  to: "/" | "/accounts" | "/requests" | "/api" | "/backups" | "/settings";
  icon: LucideIcon;
  labelKey: string;
  group: "monitor" | "manage";
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: "overview",
    to: "/",
    icon: LayoutDashboardIcon,
    labelKey: "nav.overview",
    group: "monitor",
  },
  {
    id: "requests",
    to: "/requests",
    icon: ListChecksIcon,
    labelKey: "nav.requests",
    group: "monitor",
  },
  { id: "accounts", to: "/accounts", icon: UsersIcon, labelKey: "nav.accounts", group: "manage" },
  { id: "api", to: "/api", icon: PlugIcon, labelKey: "nav.api", group: "manage" },
  { id: "backups", to: "/backups", icon: ArchiveIcon, labelKey: "nav.backups", group: "manage" },
  {
    id: "settings",
    to: "/settings",
    icon: SlidersHorizontalIcon,
    labelKey: "nav.settings",
    group: "manage",
  },
];

export const NAV_GROUPS: readonly NavItem["group"][] = ["monitor", "manage"];

/** The router reports paths without the /admin basepath; strip it defensively anyway. */
export function normalizePath(pathname: string): string {
  const stripped = pathname.replace(/^\/admin(?=\/|$)/, "");
  const trimmed = stripped.length > 1 ? stripped.replace(/\/+$/, "") : stripped;
  return trimmed || "/";
}

export function activeNavItem(pathname: string): NavItem | undefined {
  const path = normalizePath(pathname);
  return NAV_ITEMS.find((item) =>
    item.to === "/" ? path === "/" : path === item.to || path.startsWith(`${item.to}/`),
  );
}
