import {
  ArchiveIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  PlugIcon,
  SlidersHorizontalIcon,
  UsersIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { AccountStatusFilter, RequestsSearch } from "@/routes/-search";

/**
 * A saved view under a page in the sidebar: the page with one `status` filter. The labels are
 * the page's own filter labels (`ns:key`), so the sidebar and the page tabs always agree.
 */
export type NavView =
  | { id: string; labelKey: string; to: "/accounts"; status: AccountStatusFilter }
  | {
      id: string;
      labelKey: string;
      to: "/requests";
      status: NonNullable<RequestsSearch["status"]>;
    };

export interface NavItem {
  id: "overview" | "accounts" | "requests" | "api" | "backups" | "settings";
  to: "/" | "/accounts" | "/requests" | "/api" | "/backups" | "/settings";
  icon: IconSvgElement;
  labelKey: string;
  group: "monitor" | "manage";
  /** Filtered views listed under the page, as the sidebar tree shows them. */
  views?: readonly NavView[];
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
    views: [
      { id: "ok", labelKey: "requests:ok", to: "/requests", status: "success" },
      { id: "fail", labelKey: "requests:fail", to: "/requests", status: "failed" },
    ],
  },
  {
    id: "accounts",
    to: "/accounts",
    icon: UsersIcon,
    labelKey: "nav.accounts",
    group: "manage",
    views: [
      { id: "active", labelKey: "accounts:health.active", to: "/accounts", status: "active" },
      {
        id: "attention",
        labelKey: "accounts:filter.attention",
        to: "/accounts",
        status: "attention",
      },
      { id: "disabled", labelKey: "accounts:health.disabled", to: "/accounts", status: "disabled" },
    ],
  },
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

/** The view under `item` that the current `status` search value selects, if any. */
export function activeNavView(item: NavItem, status: unknown): NavView | undefined {
  return item.views?.find((view) => view.status === status);
}
