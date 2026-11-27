import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentRequestsResponse, RequestRecord } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { maskEmail } from "@/lib/privacy";
import { renderApp, renderWithProviders } from "@/test/render";
import { RequestDetailSheet } from "./request-detail-sheet";

/** The newest request of a conversation with two turns or more, whose body was kept. */
function conversationRecord(): { record: RequestRecord; turns: RequestRecord[] } {
  for (const record of mockDb.requests) {
    if (!record.conversationId || !record.hasBody || record.replayOf) continue;
    const turns = mockDb.requests.filter((item) => item.conversationId === record.conversationId);
    if (turns.length >= 2) return { record, turns };
  }
  throw new Error("no conversation in the seed");
}

function renderSheet(record: RequestRecord, onShowConversation = vi.fn()) {
  const result = renderWithProviders(
    <RequestDetailSheet
      count={1}
      onOpenChange={() => {}}
      onShowConversation={onShowConversation}
      open
      position={1}
      record={record}
    />,
  );
  return { ...result, onShowConversation };
}

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("conversations", () => {
  it("opens a request's conversation with its turns in order and the totals", async () => {
    const { record, turns } = conversationRecord();
    const { user, onShowConversation } = renderSheet(record);
    await user.click(await screen.findByRole("button", { name: "Conversation" }));

    const sheet = await screen.findByRole("dialog", { name: "Conversation" });
    expect(within(sheet).getByText(record.conversationId ?? "")).toBeInTheDocument();
    const list = await within(sheet).findByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(turns.length);
    expect(within(list).getByText("Turn 1")).toBeInTheDocument();
    const current = within(list)
      .getAllByRole("listitem")
      .find((item) => item.getAttribute("aria-current") === "true");
    expect(current && within(current).getByText("This request")).toBeTruthy();
    expect(within(sheet).getByText(`${turns.length}`)).toBeInTheDocument();

    await user.click(within(sheet).getByRole("button", { name: "Show in the log" }));
    expect(onShowConversation).toHaveBeenCalledWith(record.conversationId);
  });

  it("offers no conversation or replay while the log comes from memory, as both read the database", async () => {
    // proxy/observe.go: a row logged before the database failed keeps its id and kept body.
    const { record } = conversationRecord();
    mockServer.use(
      http.get(apiUrl("/observe/recent-requests"), () =>
        HttpResponse.json({
          requests: [record],
          total: 1,
          page: 1,
          pageSize: 25,
          sort: "time",
          order: "desc",
          persistent: false,
        } satisfies RecentRequestsResponse),
      ),
    );
    const { user } = await renderApp("/requests");
    await screen.findByText("Showing the last 200 requests from memory. History is unavailable.");
    await user.click(within(screen.getByRole("table")).getAllByRole("row")[1]);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("button", { name: "Copy as JSON" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Conversation" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Replay" })).toBeNull();
  });

  it("filters the log to one conversation from the address, with a way back", async () => {
    const { record, turns } = conversationRecord();
    const { user } = await renderApp(`/requests?conversation=${record.conversationId}`);
    expect(
      await screen.findByText(
        `Showing the turns of conversation ${record.conversationId?.slice(0, 8)}.`,
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(screen.getByRole("table")).getAllByRole("row").slice(1)).toHaveLength(
        Math.min(turns.length, 25),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Show all requests" }));
    await waitFor(() =>
      expect(screen.queryByText(/Showing the turns of conversation/)).not.toBeInTheDocument(),
    );
    // The notice took its button along; focus is on the status tab, not the page.
    expect(screen.getByRole("tab", { selected: true })).toHaveFocus();
  });
});

describe("replay", () => {
  it("runs a request again on a chosen account and logs it as a replay", async () => {
    const { record } = conversationRecord();
    const before = mockDb.requests.length;
    const { user } = renderSheet(record);
    await user.click(await screen.findByRole("button", { name: "Replay" }));

    const dialog = await screen.findByRole("dialog", { name: `Replay request #${record.id}` });
    expect(
      within(dialog).getByText(
        "A replay is a real request: it spends the chosen account's credits.",
      ),
    ).toBeInTheDocument();
    expect(await within(dialog).findByText(/Kept body: /)).toBeInTheDocument();
    const model = within(dialog).getByLabelText("Model");
    expect(model).toHaveValue(record.model);
    await user.clear(model);
    await user.type(model, "claude-haiku-4.5");
    await user.click(within(dialog).getByRole("button", { name: "Run replay" }));

    expect(await within(dialog).findByText("HTTP 200")).toBeInTheDocument();
    // Announced when the run finishes, as a failure's alert is.
    expect(within(dialog).getByText("HTTP 200").closest('[role="status"]')).not.toBeNull();
    expect(mockDb.requests).toHaveLength(before + 1);
    const logged = mockDb.requests[0];
    expect(logged.replayOf).toBe(record.id);
    expect(logged.model).toBe("claude-haiku-4.5");
    expect(within(dialog).getByText(`Logged as request #${logged.id}.`)).toBeInTheDocument();
  });

  /** Opens the replay dialog of `record` and waits for its accounts. */
  async function openReplay(record: RequestRecord) {
    const view = renderSheet(record);
    await view.user.click(await screen.findByRole("button", { name: "Replay" }));
    const dialog = await screen.findByRole("dialog", { name: `Replay request #${record.id}` });
    expect(await within(dialog).findByText(/Kept body: /)).toBeInTheDocument();
    return { ...view, dialog };
  }

  it("picks no account and says why when the request's account is disabled", async () => {
    const { record } = conversationRecord();
    const account = mockDb.accounts.find((item) => item.id === record.accountId);
    if (!account) throw new Error("the request's account is not in the seed");
    account.enabled = false;
    const { user, dialog } = await openReplay(record);
    const run = within(dialog).getByRole("button", { name: "Run replay" });
    const select = within(dialog).getByRole("combobox", { name: "Account" });
    await waitFor(() =>
      expect(select).toHaveAccessibleDescription(
        "The account this request used is disabled. Choose another one.",
      ),
    );
    expect(select).toHaveTextContent("Choose an account");
    expect(run).toBeDisabled();

    await user.click(select);
    const other = mockDb.accounts.find((item) => item.enabled && item.email);
    if (!other?.email) throw new Error("no other enabled account");
    await user.click(await screen.findByRole("option", { name: maskEmail(other.email) }));
    expect(run).toBeEnabled();
    expect(
      within(dialog).queryByText("The account this request used is disabled. Choose another one."),
    ).toBeNull();
  });

  it("treats a silenced account as off, as the pool the replay goes through leaves it out", async () => {
    const { record } = conversationRecord();
    const account = mockDb.accounts.find((item) => item.id === record.accountId);
    if (!account) throw new Error("the request's account is not in the seed");
    Object.assign(account, { enabled: true, silent: true });
    const { dialog } = await openReplay(record);
    const select = within(dialog).getByRole("combobox", { name: "Account" });
    await waitFor(() =>
      expect(select).toHaveAccessibleDescription(
        "The account this request used is disabled. Choose another one.",
      ),
    );
    expect(within(dialog).getByRole("button", { name: "Run replay" })).toBeDisabled();
  });

  it("says the request's account was removed, and waits for another", async () => {
    const { record } = conversationRecord();
    mockDb.accounts = mockDb.accounts.filter((item) => item.id !== record.accountId);
    const { dialog } = await openReplay(record);
    expect(
      await within(dialog).findByText(
        "The account this request used was removed. Choose another one.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Run replay" })).toBeDisabled();
  });

  it("says no account is enabled, and cannot run", async () => {
    const { record } = conversationRecord();
    for (const account of mockDb.accounts) account.enabled = false;
    const { dialog } = await openReplay(record);
    expect(
      await within(dialog).findByText(
        "No account is enabled. Enable one on the Accounts page to replay this request.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Run replay" })).toBeDisabled();
  });

  it("cannot run until the kept body has loaded", async () => {
    const { record } = conversationRecord();
    mockServer.use(http.get(apiUrl("/observe/requests/:id/body"), () => new Promise(() => {})));
    const { user } = renderSheet(record);
    await user.click(await screen.findByRole("button", { name: "Replay" }));
    const dialog = await screen.findByRole("dialog", { name: `Replay request #${record.id}` });
    // The accounts are in (the request's own is picked), the body is not.
    await waitFor(() =>
      expect(within(dialog).getByRole("combobox", { name: "Account" })).not.toHaveTextContent(
        "Choose an account",
      ),
    );
    expect(within(dialog).getByRole("button", { name: "Run replay" })).toBeDisabled();
  });

  it("offers no replay for a request whose body was not kept", async () => {
    const record = mockDb.requests.find((item) => item.accountId && !item.hasBody);
    if (!record) throw new Error("no row without a body");
    renderSheet(record);
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();
  });
});
