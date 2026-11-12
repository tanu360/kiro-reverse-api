import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { SECTION_ID } from "./sections";
import { UsageCard } from "./usage-card";

const ROW = "Background usage refresh";

let posted: Array<Promise<unknown>> = [];

function onRequestStart({ request }: { request: Request }): void {
  if (request.method !== "POST") return;
  posted.push(
    request
      .clone()
      .text()
      .then((text) => (text ? JSON.parse(text) : null)),
  );
}

beforeEach(() => {
  posted = [];
  mockServer.events.on("request:start", onRequestStart);
});

afterEach(() => {
  mockServer.events.removeListener("request:start", onRequestStart);
});

async function renderCard(lang?: "zh") {
  const result = renderWithProviders(<UsageCard />, { lang });
  const card = await waitFor(() => {
    const element = document.getElementById(SECTION_ID.usage);
    if (!element || !within(element).queryByRole("combobox")) throw new Error("not loaded");
    return element;
  });
  return { ...result, card };
}

describe("UsageRefreshRow", () => {
  it("shows Every 30 minutes by default", async () => {
    const { card } = await renderCard();
    expect(within(card).getByRole("combobox", { name: ROW })).toHaveTextContent("Every 30 minutes");
  });

  it("saves Off as it is picked, with no Save button", async () => {
    const { card, user } = await renderCard();
    expect(within(card).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();

    const select = within(card).getByRole("combobox", { name: ROW });
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "Off" }));

    expect(await screen.findByText("Your settings were saved.")).toBeInTheDocument();
    expect(await Promise.all(posted)).toEqual([{ usageRefreshIntervalMinutes: 0 }]);
    expect(mockDb.settings.usageRefreshIntervalMinutes).toBe(0);
    expect(select).toHaveTextContent("Off");
  });

  it("labels whole hours in hours", async () => {
    const { card, user } = await renderCard();
    const select = within(card).getByRole("combobox", { name: ROW });
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "Every 24 hours" }));

    await waitFor(() => expect(mockDb.settings.usageRefreshIntervalMinutes).toBe(1440));
    expect(select).toHaveTextContent("Every 24 hours");
  });

  it("keeps a stored value the presets lack visible, in order", async () => {
    mockDb.settings.usageRefreshIntervalMinutes = 45;
    const { card, user } = await renderCard();
    const select = within(card).getByRole("combobox", { name: ROW });
    expect(select).toHaveTextContent("Every 45 minutes");

    await user.click(select);
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual([
      "Off",
      "Every 5 minutes",
      "Every 10 minutes",
      "Every 15 minutes",
      "Every 30 minutes",
      "Every 45 minutes",
      "Every 1 hour",
      "Every 2 hours",
      "Every 6 hours",
      "Every 12 hours",
      "Every 24 hours",
    ]);
  });

  it("puts the saved interval back when the save fails", async () => {
    mockServer.use(
      http.post(apiUrl("/settings"), () =>
        HttpResponse.json({ error: "settings store unavailable" }, { status: 500 }),
      ),
    );
    const { card, user } = await renderCard();
    const select = within(card).getByRole("combobox", { name: ROW });

    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "Every 2 hours" }));

    expect(await screen.findAllByText(/Could not save settings/)).not.toHaveLength(0);
    await waitFor(() => expect(select).toHaveTextContent("Every 30 minutes"));
    expect(mockDb.settings.usageRefreshIntervalMinutes).toBe(30);
  });

  it("reads in Chinese", async () => {
    const { card } = await renderCard("zh");
    expect(within(card).getByRole("combobox", { name: "后台用量刷新" })).toHaveTextContent(
      "每 30 分钟",
    );
  });
});
