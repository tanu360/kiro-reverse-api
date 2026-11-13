import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockDb, mockNowUnix } from "@/lib/mocks/db";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { SECTION_ID } from "./sections";
import { SelfHealCard } from "./self-heal-card";

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

async function writes(): Promise<Recorded[]> {
  return (await Promise.all(recorded)).filter((r) => r.method !== "GET");
}

beforeEach(() => {
  recorded = [];
  mockServer.events.on("request:start", onRequestStart);
});

afterEach(() => {
  mockServer.events.removeListener("request:start", onRequestStart);
});

async function renderCard() {
  const result = renderWithProviders(<SelfHealCard />);
  await screen.findByRole("switch", { name: "Bring back accounts the proxy blocked" });
  const card = document.getElementById(SECTION_ID.selfHeal);
  if (!card) throw new Error("self-heal card not rendered");
  return { ...result, card };
}

describe("SelfHealCard", () => {
  it("shows the defaults: on, 300 s, 5 heals, never healed", async () => {
    const { card } = await renderCard();
    expect(
      within(card).getByRole("switch", { name: "Bring back accounts the proxy blocked" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(within(card).getByLabelText("Minimum time between heals")).toHaveValue("300");
    expect(within(card).getByLabelText("Maximum heals without a successful request")).toHaveValue(
      "5",
    );
    expect(
      within(card).getByText("The proxy has not needed to heal any account yet."),
    ).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
  });

  it("marks an out-of-range interval and round cap and sends nothing", async () => {
    const { card, user } = await renderCard();
    const interval = within(card).getByLabelText("Minimum time between heals");
    const rounds = within(card).getByLabelText("Maximum heals without a successful request");

    await user.clear(interval);
    await user.type(interval, "29");
    await user.clear(rounds);
    await user.type(rounds, "101");
    await user.click(within(card).getByRole("button", { name: "Save" }));

    expect(
      await within(card).findByText("Enter a whole number of seconds from 30 to 86400."),
    ).toBeInTheDocument();
    expect(within(card).getByText("Enter a whole number from 0 to 100.")).toBeInTheDocument();
    expect(interval).toHaveAttribute("aria-invalid", "true");
    expect(rounds).toHaveAttribute("aria-invalid", "true");
    expect(await writes()).toEqual([]);
  });

  it("saves the switch and both numbers in one patch; 0 rounds means no limit", async () => {
    const { card, user } = await renderCard();
    await user.click(
      within(card).getByRole("switch", { name: "Bring back accounts the proxy blocked" }),
    );
    const rounds = within(card).getByLabelText("Maximum heals without a successful request");
    await user.clear(rounds);
    await user.type(rounds, "0");
    await user.click(within(card).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Your settings were saved.")).toBeInTheDocument();
    expect(await writes()).toEqual([
      {
        method: "POST",
        path: "/account-health",
        body: { enabled: false, minIntervalSec: 300, maxRounds: 0 },
      },
    ]);
    expect(mockDb.accountHealth).toMatchObject({ enabled: false, maxRounds: 0 });
  });

  it("shows a halt with the last heal, and Resume lifts it", async () => {
    mockDb.accountHealth.state = {
      lastHealAt: mockNowUnix() - 120,
      rounds: 5,
      halted: true,
      haltedAt: mockNowUnix() - 10,
      lastHealed: 2,
    };
    const { card, user } = await renderCard();

    expect(
      within(card).getByText(
        "Self-heal stopped after reaching its limit without a successful request. Check the accounts, then resume.",
      ),
    ).toBeInTheDocument();
    expect(card).toHaveTextContent("2 accounts came back 2 minutes ago.");
    expect(
      within(card).getByText(/5 of 5 heals used since the last successful request\./),
    ).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Resume" }));

    expect(await screen.findByText("Self-heal resumed.")).toBeInTheDocument();
    expect(await writes()).toEqual([
      { method: "POST", path: "/account-health/resume", body: null },
    ]);
    expect(await within(card).findByText(/0 of 5 heals used/)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
  });
});
