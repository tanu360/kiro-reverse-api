import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { ImageResizeCard } from "./image-resize-card";
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

const SWITCH = "Shrink large images before sending them";
const DIMENSION = "Maximum width or height";
const SIZE = "Maximum file size";

async function renderCard() {
  mockDb.settings = {
    ...mockDb.settings,
    imageResize: true,
    imageResizeMaxDimension: 1568,
    imageResizeMaxKB: 400,
  };
  const result = renderWithProviders(<ImageResizeCard />);
  await screen.findByRole("switch", { name: SWITCH });
  const card = document.getElementById(SECTION_ID.imageResize);
  if (!card) throw new Error("image-resize card not rendered");
  return { ...result, card };
}

describe("ImageResizeCard", () => {
  it("turns both limits off while resizing is off, as nothing reads them then", async () => {
    const { card, user } = await renderCard();
    const dimension = within(card).getByLabelText(DIMENSION);
    const size = within(card).getByLabelText(SIZE);
    expect(dimension).toBeEnabled();

    await user.click(within(card).getByRole("switch", { name: SWITCH }));
    expect(dimension).toBeDisabled();
    expect(size).toBeDisabled();
  });

  it("saves resizing off with the saved limits when a field it ignores is out of range", async () => {
    const { card, user } = await renderCard();
    await user.clear(within(card).getByLabelText(SIZE));
    await user.click(within(card).getByRole("switch", { name: SWITCH }));
    await user.click(within(card).getByRole("button", { name: "Save" }));

    await screen.findByText("Saved");
    expect(await Promise.all(bodies)).toEqual([
      { imageResize: false, imageResizeMaxDimension: 1568, imageResizeMaxKB: 400 },
    ]);
  });
});
