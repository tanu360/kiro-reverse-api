import { redirectTarget } from "@/routes/-search";

export interface UserLoginSearch {
  redirect?: string;
}

/** "/user" and the pages under it, by plain path segments only ("." and ".." never match). */
const USER_PANEL_PATH = /^\/user(?:\/[\w-]+)*\/?$/;

/**
 * A page of the user panel, optionally with a query: "/user" or "/user/…", never the sign-in page
 * itself. A key holder's sign-in only ever leads into the user panel, never to an admin page.
 */
function isUserPanelTarget(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const path = value.split(/[?#]/, 1)[0] ?? "";
  return USER_PANEL_PATH.test(path) && path.replace(/\/$/, "") !== "/user/login";
}

/** The search of /user/login: `redirect` only when it is a user panel page. */
export function validateUserLoginSearch(input: Record<string, unknown>): UserLoginSearch {
  return { redirect: isUserPanelTarget(input.redirect) ? input.redirect : undefined };
}

/** Where a key holder goes after signing in: `redirect` when it is a user panel page, else /user. */
export function userRedirectTarget(redirect: string | undefined): {
  to: string;
  search: Record<string, string>;
} {
  return isUserPanelTarget(redirect) ? redirectTarget(redirect) : { to: "/user", search: {} };
}
