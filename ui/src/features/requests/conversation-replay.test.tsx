import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestRecord } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
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
    expect(mockDb.requests).toHaveLength(before + 1);
    const logged = mockDb.requests[0];
    expect(logged.replayOf).toBe(record.id);
    expect(logged.model).toBe("claude-haiku-4.5");
    expect(within(dialog).getByText(`Logged as request #${logged.id}.`)).toBeInTheDocument();
  });

  it("offers no replay for a request whose body was not kept", async () => {
    const record = mockDb.requests.find((item) => item.accountId && !item.hasBody);
    if (!record) throw new Error("no row without a body");
    renderSheet(record);
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();
  });
});
