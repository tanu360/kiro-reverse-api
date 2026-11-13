import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp } from "@/test/render";
import { unusableStatus } from "./duplicates-dialog";

// The whole app renders per test, so a busy run needs more than the 5 s default.
vi.setConfig({ testTimeout: 15_000 });

const DANA = "dana.whitfield@northwind-labs.com";
const DANA_MASKED = "da***@no***.com";
const COPY_ID = "dana-copy";
const OTHER = "m.oyelaran@outlook.com";

/** Stores Dana a second time: same user, an older refresh, so the original is the suggestion. */
function addDanaCopy(): Account {
  const dana = mockDb.accounts.find((account) => account.email === DANA) as Account;
  mockDb.accounts.push({
    ...dana,
    id: COPY_ID,
    nickname: "Imported copy",
    lastRefresh: dana.lastRefresh - 3600,
    requestCount: 5,
  });
  return dana;
}

async function renderAccounts() {
  const view = await renderApp("/accounts");
  const table = await screen.findByRole("table", { name: "Accounts" });
  await within(table).findAllByText(DANA_MASKED);
  return view;
}

async function openReview(
  user: Awaited<ReturnType<typeof renderAccounts>>["user"],
  noticeTitle = "1 duplicate account",
) {
  const title = await screen.findByText(noticeTitle);
  const notice = title.closest<HTMLElement>('[data-slot="alert"]') as HTMLElement;
  await user.click(within(notice).getByRole("button", { name: "Review" }));
  return screen.findByRole("dialog", { name: "Duplicate accounts" });
}

describe("Duplicate accounts", () => {
  it("hides the notice without duplicates", async () => {
    let checked = false;
    mockServer.use(
      http.get(apiUrl("/accounts/duplicates"), () => {
        checked = true;
        return undefined;
      }),
    );
    await renderAccounts();
    await waitFor(() => expect(checked).toBe(true));
    expect(screen.queryByText(/duplicate account/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
  });

  it("shows the duplicate count and suggested keeper", async () => {
    addDanaCopy();
    const { user } = await renderAccounts();
    expect(await screen.findByText("1 duplicate account")).toBeInTheDocument();

    const dialog = await openReview(user);
    // What the duplicates are, why they matter, what to pick, what Merge does and what the
    // backup it saves first can bring back.
    expect(within(dialog).getByText("Some Kiro users were added more than once.")).toBeVisible();
    expect(
      within(dialog).getByText(
        "Copies of one user share one set of credits, so the extra copies add no credits.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "For each user, choose the account to keep. Users you leave out of the merge stay as they are.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Merge deletes the other copies and moves their requests and stats to the account you keep.",
      ),
    ).toBeInTheDocument();
    // A restore rolls back everything, not only the merge, so the text promises no undo.
    expect(
      within(dialog).getByText(
        "A backup is saved first. Restoring it in Backups returns all accounts and settings to how they were before the merge, so later changes, such as refreshed tokens, are lost.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/undo/i)).not.toBeInTheDocument();
    // The button says how many copies it deletes.
    expect(within(dialog).getByRole("button", { name: "Merge 1 copy" })).toBeEnabled();
    expect(
      within(dialog).getByRole("region", { name: "User 1 · added 2 times" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Matched by: same email with the same sign-in method"),
    ).toBeInTheDocument();
    const radios = within(dialog).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    // The original was refreshed last, so it is the suggestion and starts checked.
    expect(radios[0]).toBeChecked();
    expect(radios[1]).not.toBeChecked();
    const cards = within(dialog).getAllByText(DANA_MASKED);
    expect(cards).toHaveLength(2);
    expect(within(dialog).getAllByText("Suggested to keep")).toHaveLength(1);
    expect(within(dialog).getByText(/Imported copy/)).toBeInTheDocument();
    expect(within(dialog).getByText(/5 requests/)).toBeInTheDocument();
  });

  it("merges with the chosen keeper", async () => {
    const dana = addDanaCopy();
    const bodies: unknown[] = [];
    mockServer.use(
      http.post(apiUrl("/accounts/duplicates/merge"), async ({ request }) => {
        bodies.push(await request.clone().json());
        return undefined;
      }),
    );
    const { user } = await renderAccounts();
    const dialog = await openReview(user);

    await user.click(within(dialog).getAllByRole("radio")[1] as HTMLElement);
    await user.click(within(dialog).getByRole("button", { name: "Merge 1 copy" }));

    expect(
      await screen.findByText(
        "Merged the duplicates and deleted 1 extra copy. A backup was saved first.",
      ),
    ).toBeInTheDocument();
    expect(bodies).toEqual([{ keepId: COPY_ID, ids: [dana.id, COPY_ID] }]);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Duplicate accounts" })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.queryByText("1 duplicate account")).not.toBeInTheDocument());
    expect(mockDb.accounts.some((account) => account.id === dana.id)).toBe(false);
  });

  it("merges only the groups left switched on", async () => {
    const dana = addDanaCopy();
    const other = mockDb.accounts.find((account) => account.email === OTHER) as Account;
    mockDb.accounts.push({ ...other, id: "other-copy", lastRefresh: other.lastRefresh - 3600 });
    const bodies: unknown[] = [];
    mockServer.use(
      http.post(apiUrl("/accounts/duplicates/merge"), async ({ request }) => {
        bodies.push(await request.clone().json());
        return undefined;
      }),
    );
    const { user } = await renderAccounts();
    const title = await screen.findByText("2 duplicate accounts");
    const notice = title.closest<HTMLElement>('[data-slot="alert"]') as HTMLElement;
    await user.click(within(notice).getByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate accounts" });

    const switches = within(dialog).getAllByRole("switch", { name: "Include in merge" });
    expect(switches).toHaveLength(2);
    for (const toggle of switches) expect(toggle).toBeChecked();
    const otherGroup = within(dialog).getByRole("region", { name: "User 2 · added 2 times" });
    // One press merges every group switched on, and the button counts what it deletes.
    expect(within(dialog).getByRole("button", { name: "Merge 2 copies" })).toBeEnabled();

    // A group switched off is left out: its keeper choice is disabled and it is not merged.
    await user.click(switches[1] as HTMLElement);
    for (const radio of within(otherGroup).getAllByRole("radio")) {
      expect(radio).toHaveAttribute("aria-disabled", "true");
    }
    expect(within(dialog).getByRole("button", { name: "Merge 1 copy" })).toBeEnabled();
    await user.click(switches[0] as HTMLElement);
    expect(within(dialog).getByRole("button", { name: "Merge" })).toBeDisabled();
    await user.click(switches[0] as HTMLElement);
    await user.click(within(dialog).getByRole("button", { name: "Merge 1 copy" }));

    expect(
      await screen.findByText(
        "Merged the duplicates and deleted 1 extra copy. A backup was saved first.",
      ),
    ).toBeInTheDocument();
    expect(bodies).toEqual([{ keepId: dana.id, ids: [dana.id, COPY_ID] }]);
    expect(mockDb.accounts.some((account) => account.id === "other-copy")).toBe(true);
    expect(await screen.findByText("1 duplicate account")).toBeInTheDocument();
  });

  it("names why a copy cannot serve requests instead of a vague warning", async () => {
    const dana = addDanaCopy();
    const copy = mockDb.accounts.find((account) => account.id === COPY_ID) as Account;
    copy.enabled = false;
    copy.lastRefresh = dana.lastRefresh + 60;
    const { user } = await renderAccounts();
    const dialog = await openReview(user);
    const cards = within(dialog).getAllByRole("radio");
    // The newer copy is switched off, so the working original stays the suggestion.
    expect(cards[0]).toBeChecked();
    expect(within(dialog).getByText("Disabled")).toBeInTheDocument();
    expect(within(dialog).queryByText("Needs attention")).not.toBeInTheDocument();
  });

  it("shows a copy's status with the accounts list's own pill", async () => {
    const dana = addDanaCopy();
    const copy = mockDb.accounts.find((account) => account.id === COPY_ID) as Account;
    copy.enabled = false;
    mockDb.accounts.push({ ...dana, id: "dana-banned", banStatus: "BANNED", banReason: "" });
    const { user } = await renderAccounts();
    const table = screen.getByRole("table", { name: "Accounts" });
    const dialog = await openReview(user, "2 duplicate accounts");

    // Same word, colour and icon as the list: red for a ban, grey for a switched-off copy.
    for (const status of ["disabled", "banned"]) {
      const listPill = table.querySelector<HTMLElement>(`[data-status="${status}"]`);
      const dialogPill = dialog.querySelector<HTMLElement>(`[data-status="${status}"]`);
      expect(listPill).not.toBeNull();
      expect(dialogPill).not.toBeNull();
      expect(dialogPill?.className).toBe(listPill?.className);
      expect(dialogPill?.textContent).toBe(listPill?.textContent);
      expect(dialogPill?.querySelector("svg")?.innerHTML).toBe(
        listPill?.querySelector("svg")?.innerHTML,
      );
    }
    expect(dialog.querySelector('[data-status="banned"]')?.className).toContain("--pill-error-bg");
    expect(dialog.querySelector('[data-status="disabled"]')?.className).toContain(
      "--pill-neutral-bg",
    );
  });

  it("maps every unhealthy copy to the status the accounts list shows", () => {
    const base = {
      id: "a",
      email: "",
      nickname: "",
      authMethod: "social",
      provider: "Google",
      region: "us-east-1",
      enabled: true,
      healthy: false,
      banStatus: "",
      silent: false,
      lastRefresh: 0,
      expiresAt: 0,
      lastUsed: 0,
      requestCount: 0,
      errorCount: 0,
    };
    expect(unusableStatus({ ...base, healthy: true })).toBeNull();
    expect(unusableStatus({ ...base, banStatus: "BANNED" })).toBe("banned");
    expect(unusableStatus({ ...base, banStatus: "SUSPENDED" })).toBe("suspended");
    expect(unusableStatus({ ...base, banStatus: "DISABLED" })).toBe("disabled");
    expect(unusableStatus({ ...base, enabled: false })).toBe("disabled");
    expect(unusableStatus({ ...base, silent: true })).toBe("disabled");
    // Enabled, not held and still unhealthy: the server found no token or key.
    expect(unusableStatus(base)).toBe("noToken");
  });

  it("shows the changed-group error", async () => {
    addDanaCopy();
    mockServer.use(
      http.post(apiUrl("/accounts/duplicates/merge"), () =>
        HttpResponse.json(
          { error: "These accounts are no longer duplicates", code: "duplicates_changed" },
          { status: 409 },
        ),
      ),
    );
    const { user } = await renderAccounts();
    const dialog = await openReview(user);
    await user.click(within(dialog).getByRole("button", { name: "Merge 1 copy" }));

    const matches = await screen.findAllByText(
      "These accounts are no longer duplicates. Review the duplicates again.",
    );
    // One error toast (the toast region also announces it to screen readers).
    expect(matches.filter((node) => node.getAttribute("data-slot") === "toast-title")).toHaveLength(
      1,
    );
    // Nothing was merged, so the dialog stays for another look.
    expect(screen.getByRole("dialog", { name: "Duplicate accounts" })).toBeInTheDocument();
    expect(mockDb.accounts.some((account) => account.id === COPY_ID)).toBe(true);
  });
});
