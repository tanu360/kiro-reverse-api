import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { clearSession, type SessionChangeReason } from "@/lib/auth/session";
import { mockServer } from "@/lib/mocks/node";
import { queryClient } from "@/lib/query-client";
import { renderApp } from "@/test/render";

// Endpoints that legitimately run without a session.
const PUBLIC = new Set(["/admin/api/first-run", "/admin/api/session"]);

/** Records every admin request sent without a token from now on. */
function recordTokenless(): string[] {
  const tokenless: string[] = [];
  mockServer.events.on("request:start", ({ request }) => {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/admin/api/") || PUBLIC.has(pathname)) return;
    if (!request.headers.has("X-Admin-Token")) tokenless.push(`${request.method} ${pathname}`);
  });
  return tokenless;
}

afterEach(() => {
  mockServer.events.removeAllListeners();
  queryClient.clear();
});

// The app's own query client clears its cache when the session ends, and the page that is
// still mounted re-renders before the redirect to /login lands.
describe("ending the session on a mounted page", () => {
  it("sends no admin request without a token after a backup restore", async () => {
    const { router, user } = await renderApp("/backups", { queryClient });
    const table = await screen.findByRole("table", { name: "Backups, newest first" });
    await waitFor(() => expect(within(table).getAllByRole("row").length).toBeGreaterThan(1));
    const tokenless = recordTokenless();

    const firstRow = within(table).getAllByRole("row")[1];
    await user.click(within(firstRow).getByRole("button", { name: "Restore" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Restore" }),
    );

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(tokenless).toEqual([]);
  });

  it.each<SessionChangeReason>(["signout", "expired"])(
    "sends no admin request without a token after '%s'",
    async (reason) => {
      const { router } = await renderApp("/accounts", { queryClient });
      await screen.findByRole("table");
      const tokenless = recordTokenless();

      act(() => clearSession(reason));
      await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
      expect(tokenless).toEqual([]);
    },
  );
});
