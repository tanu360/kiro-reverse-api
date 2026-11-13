import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { SECTION_ID } from "./sections";
import { ServerLogCard } from "./server-log-card";

const ROW = "Log level";
const DEBUG_WARNING = /Debug also writes request contents/;
const ENV_NOTE = /LOG_LEVEL environment variable is set/;

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
  const result = renderWithProviders(<ServerLogCard />, { lang });
  const card = await waitFor(() => {
    const element = document.getElementById(SECTION_ID.serverLog);
    if (!element || !within(element).queryByRole("combobox")) throw new Error("not loaded");
    return element;
  });
  return { ...result, card };
}

describe("ServerLogCard", () => {
  it("shows Info by default, with no notice", async () => {
    const { card } = await renderCard();
    expect(within(card).getByRole("combobox", { name: ROW })).toHaveTextContent("Info (default)");
    expect(within(card).queryByText(DEBUG_WARNING)).not.toBeInTheDocument();
    expect(within(card).queryByText(ENV_NOTE)).not.toBeInTheDocument();
  });

  it("saves Debug as it is picked and warns what debug writes", async () => {
    const { card, user } = await renderCard();
    expect(within(card).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();

    const select = within(card).getByRole("combobox", { name: ROW });
    await user.click(select);
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual(["Debug", "Info (default)", "Warnings and errors", "Errors only"]);
    await user.click(await screen.findByRole("option", { name: "Debug" }));

    expect(await screen.findByText("Your settings were saved.")).toBeInTheDocument();
    expect(await Promise.all(posted)).toEqual([{ logLevel: "debug" }]);
    expect(mockDb.settings.logLevel).toBe("debug");
    expect(select).toHaveTextContent("Debug");
    expect(within(card).getByText(DEBUG_WARNING)).toBeInTheDocument();
  });

  it("puts the saved level back when the save fails", async () => {
    mockServer.use(
      http.post(apiUrl("/settings"), () =>
        HttpResponse.json({ error: "settings store unavailable" }, { status: 500 }),
      ),
    );
    const { card, user } = await renderCard();
    const select = within(card).getByRole("combobox", { name: ROW });

    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "Errors only" }));

    expect(await screen.findAllByText(/Could not save settings/)).not.toHaveLength(0);
    await waitFor(() => expect(select).toHaveTextContent("Info (default)"));
    expect(mockDb.settings.logLevel).toBe("info");
  });

  it("says when LOG_LEVEL picks the level at each start", async () => {
    mockDb.settings.logLevelFromEnv = true;
    const { card } = await renderCard();
    expect(within(card).getByText(ENV_NOTE)).toBeInTheDocument();
  });

  it("reads in Chinese", async () => {
    const { card } = await renderCard("zh");
    expect(within(card).getByRole("combobox", { name: "日志级别" })).toHaveTextContent(
      "信息（默认）",
    );
  });
});
