import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp } from "@/test/render";

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

async function openReview(user: Awaited<ReturnType<typeof renderAccounts>>["user"]) {
  const title = await screen.findByText("1 duplicate account");
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
    expect(within(dialog).getByText("Group 1")).toBeInTheDocument();
    expect(within(dialog).getByText("Same email and sign-in method")).toBeInTheDocument();
    const radios = within(dialog).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    // The original was refreshed last, so it is the suggestion and starts checked.
    expect(radios[0]).toBeChecked();
    expect(radios[1]).not.toBeChecked();
    const cards = within(dialog).getAllByText(DANA_MASKED);
    expect(cards).toHaveLength(2);
    expect(within(dialog).getAllByText("Suggested")).toHaveLength(1);
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
    await user.click(within(dialog).getByRole("button", { name: "Merge" }));

    expect(
      await screen.findByText("Merged the duplicates and deleted 1 account."),
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

    const switches = within(dialog).getAllByRole("switch", { name: "Merge this group" });
    expect(switches).toHaveLength(2);
    for (const toggle of switches) expect(toggle).toBeChecked();
    const otherGroup = within(dialog).getByRole("region", { name: "Group 2" });

    // A group switched off is left out: its keeper choice is disabled and it is not merged.
    await user.click(switches[1] as HTMLElement);
    for (const radio of within(otherGroup).getAllByRole("radio")) {
      expect(radio).toHaveAttribute("aria-disabled", "true");
    }
    await user.click(switches[0] as HTMLElement);
    expect(within(dialog).getByRole("button", { name: "Merge" })).toBeDisabled();
    await user.click(switches[0] as HTMLElement);
    await user.click(within(dialog).getByRole("button", { name: "Merge" }));

    expect(
      await screen.findByText("Merged the duplicates and deleted 1 account."),
    ).toBeInTheDocument();
    expect(bodies).toEqual([{ keepId: dana.id, ids: [dana.id, COPY_ID] }]);
    expect(mockDb.accounts.some((account) => account.id === "other-copy")).toBe(true);
    expect(await screen.findByText("1 duplicate account")).toBeInTheDocument();
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
    await user.click(within(dialog).getByRole("button", { name: "Merge" }));

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
