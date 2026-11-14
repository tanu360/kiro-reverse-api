import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { LogRetentionCard } from "./log-retention-card";
import { SECTION_ID } from "./sections";

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

let recorded: Array<Promise<Recorded>> = [];

function onRequestStart({ request }: { request: Request }): void {
  const path = new URL(request.url).pathname.replace(/^\/admin\/api/, "");
  recorded.push(
    request
      .clone()
      .text()
      .then((text) => ({ method: request.method, path, body: text ? JSON.parse(text) : null })),
  );
}

/** Every write the card sent, in order. */
async function writes(): Promise<Recorded[]> {
  const all = await Promise.all(recorded);
  return all.filter((r) => r.method !== "GET");
}

beforeEach(() => {
  recorded = [];
  mockServer.events.on("request:start", onRequestStart);
});

afterEach(() => {
  mockServer.events.removeListener("request:start", onRequestStart);
});

async function renderCard() {
  const result = renderWithProviders(<LogRetentionCard />);
  const days = await screen.findByLabelText("Keep entries for (days)");
  const card = document.getElementById(SECTION_ID.logRetention);
  if (!card) throw new Error("log retention card not rendered");
  const save = within(card).getByRole("button", { name: "Save" });
  return { ...result, card, days, save };
}

describe("LogRetentionCard", () => {
  it("shows the saved days and what the last cleanup did", async () => {
    const { card, days, save } = await renderCard();
    expect(within(card).queryByRole("switch")).not.toBeInTheDocument();
    expect(days).toHaveValue("90");
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(card).toHaveTextContent("0 to 365; 0 keeps every entry forever.");
    expect(within(card).queryByText("Kept forever")).not.toBeInTheDocument();
    expect(card).toHaveTextContent("Last cleanup 3 hours ago · 449 entries deleted · Oldest entry");
    expect(card).toHaveTextContent("18,240 deleted requests still counted in totals");
  });

  it("says when no cleanup ran yet", async () => {
    mockDb.logRetention.lastRunAt = 0;
    mockDb.logRetention.archivedRequests = 1;
    const { card } = await renderCard();
    expect(card).toHaveTextContent("No cleanup since the server started · Oldest entry");
    expect(card).toHaveTextContent("1 deleted request still counted in totals");
    expect(card).not.toHaveTextContent("Last cleanup");
  });

  it("saves 0 days to keep every entry forever", async () => {
    const { user, card, days, save } = await renderCard();
    await user.clear(days);
    await user.type(days, "0");
    expect(within(card).getByText("Kept forever")).toBeInTheDocument();
    await user.click(save);

    expect(await screen.findByText("Your settings were saved.")).toBeInTheDocument();
    expect(await writes()).toEqual([{ method: "POST", path: "/log-retention", body: { days: 0 } }]);
    expect(mockDb.logRetention.days).toBe(0);
    await waitFor(() => expect(save).toHaveAttribute("aria-disabled", "true"));
    expect(days).toHaveValue("0");
  });

  it("shows a saved keep-forever as 0 days", async () => {
    mockDb.logRetention.days = 0;
    const { card, days } = await renderCard();
    expect(days).toHaveValue("0");
    expect(within(card).getByText("Kept forever")).toBeInTheDocument();
  });

  it("shows a field error past the maximum and sends nothing", async () => {
    const { user, card, days, save } = await renderCard();
    await user.clear(days);
    await user.type(days, "400");
    await user.click(save);

    expect(
      await within(card).findByText("Days must be a whole number from 0 to 365."),
    ).toBeInTheDocument();
    expect(days).toHaveAttribute("aria-invalid", "true");
    expect(await writes()).toEqual([]);
  });

  it("saves a new number of days", async () => {
    const { user, days, save } = await renderCard();
    await user.clear(days);
    await user.type(days, "30");
    await user.click(save);

    expect(await screen.findByText("Your settings were saved.")).toBeInTheDocument();
    expect(await writes()).toEqual([
      { method: "POST", path: "/log-retention", body: { days: 30 } },
    ]);
    expect(mockDb.logRetention.days).toBe(30);
    await waitFor(() => expect(days).toHaveValue("30"));
  });
});
