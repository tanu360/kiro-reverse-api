import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { AutoContinueCard } from "./auto-continue-card";
import { SECTION_ID } from "./sections";

let bodies: Array<Promise<unknown>> = [];

function onRequestStart({ request }: { request: Request }): void {
  if (request.method !== "GET") bodies.push(request.clone().json());
}

beforeEach(() => {
  bodies = [];
  mockServer.events.on("request:start", onRequestStart);
});

afterEach(() => {
  mockServer.events.removeListener("request:start", onRequestStart);
});

const SWITCH = "Continue answers cut off by the output limit";
const MAX = "Maximum continuations per answer";

async function renderCard(autoContinue: boolean) {
  mockDb.settings = { ...mockDb.settings, autoContinue, autoContinueMax: 3 };
  const result = renderWithProviders(<AutoContinueCard />);
  await screen.findByRole("switch", { name: SWITCH });
  const card = document.getElementById(SECTION_ID.autoContinue);
  if (!card) throw new Error("auto-continue card not rendered");
  return { ...result, card };
}

describe("AutoContinueCard", () => {
  it("turns the limit off while auto-continue is off, as nothing reads it then", async () => {
    const { card, user } = await renderCard(false);
    const max = within(card).getByLabelText(MAX);
    expect(max).toBeDisabled();

    await user.click(within(card).getByRole("switch", { name: SWITCH }));
    expect(max).toBeEnabled();
  });

  it("saves auto-continue off with the saved limit when the field it ignores is empty", async () => {
    const { card, user } = await renderCard(true);
    await user.clear(within(card).getByLabelText(MAX));
    await user.click(within(card).getByRole("switch", { name: SWITCH }));
    await user.click(within(card).getByRole("button", { name: "Save" }));

    await screen.findByText("Saved");
    expect(await Promise.all(bodies)).toEqual([{ autoContinue: false, autoContinueMax: 3 }]);
  });

  it("drops the limit's error once auto-continue is turned off", async () => {
    const { card, user } = await renderCard(true);
    await user.clear(within(card).getByLabelText(MAX));
    await user.click(within(card).getByRole("button", { name: "Save" }));
    const error = /Maximum continuations must be a whole number/;
    expect(await within(card).findByText(error)).toBeInTheDocument();

    await user.click(within(card).getByRole("switch", { name: SWITCH }));
    expect(within(card).queryByText(error)).not.toBeInTheDocument();
  });
});
