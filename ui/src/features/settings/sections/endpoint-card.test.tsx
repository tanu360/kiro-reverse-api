import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EndpointConfig } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { EndpointCard } from "./endpoint-card";
import { SECTION_ID } from "./sections";

let saved: Array<Promise<unknown>> = [];

function onRequestStart({ request }: { request: Request }): void {
  if (request.method === "PUT" || request.method === "POST") {
    saved.push(request.clone().json());
  }
}

beforeEach(() => {
  saved = [];
  mockServer.events.on("request:start", onRequestStart);
});

afterEach(() => {
  mockServer.events.removeListener("request:start", onRequestStart);
});

async function renderCard(endpoint: EndpointConfig) {
  mockDb.endpoint = endpoint;
  const result = renderWithProviders(<EndpointCard />);
  await screen.findByRole("combobox", { name: "Chat API" });
  const card = document.getElementById(SECTION_ID.endpoint);
  if (!card) throw new Error("endpoint card not rendered");
  return { ...result, card };
}

const ENDPOINT_UNUSED =
  "Not used: the newer chat API (CreateResponse) has one endpoint of its own.";
const FALLBACK_BUILT_IN = "Automatic already tries every endpoint in turn.";

describe("EndpointCard", () => {
  it("puts the chat API first, as the endpoint rows depend on it", async () => {
    const { card } = await renderCard({
      preferredEndpoint: "kiro",
      endpointFallback: true,
      chatApi: "auto",
    });
    const order = [...card.querySelectorAll('[data-slot="settings-row"]')].map(
      (row) => row.textContent ?? "",
    );
    expect(order[0]).toContain("Chat API");
    expect(order[1]).toContain("Preferred endpoint");
    expect(order[2]).toContain("Fall back to other endpoints");
  });

  it("turns the endpoint rows off while every account uses CreateResponse", async () => {
    const { card } = await renderCard({
      preferredEndpoint: "amazonq",
      endpointFallback: true,
      chatApi: "responses",
    });
    const preferred = within(card).getByRole("combobox", { name: "Preferred endpoint" });
    const fallback = within(card).getByRole("switch", { name: "Fall back to other endpoints" });
    expect(preferred).toHaveAttribute("data-disabled");
    expect(fallback).toHaveAttribute("data-disabled");
    expect(preferred).toHaveAccessibleDescription(ENDPOINT_UNUSED);
    expect(fallback).toHaveAccessibleDescription(ENDPOINT_UNUSED);
  });

  it("turns the fallback switch off for Automatic, which tries every endpoint", async () => {
    const { card, user } = await renderCard({
      preferredEndpoint: "auto",
      endpointFallback: false,
      chatApi: "auto",
    });
    const fallback = within(card).getByRole("switch", { name: "Fall back to other endpoints" });
    expect(fallback).toHaveAttribute("data-disabled");
    expect(fallback).toHaveAccessibleDescription(FALLBACK_BUILT_IN);

    await user.click(within(card).getByRole("combobox", { name: "Preferred endpoint" }));
    await user.click(await screen.findByRole("option", { name: "Amazon Q" }));
    expect(fallback).not.toHaveAttribute("data-disabled");
    expect(fallback).toHaveAccessibleDescription("When off, only the selected endpoint is used.");
  });

  it("follows the chat API picked in the form, before it is saved", async () => {
    const { card, user } = await renderCard({
      preferredEndpoint: "kiro",
      endpointFallback: true,
      chatApi: "auto",
    });
    const preferred = within(card).getByRole("combobox", { name: "Preferred endpoint" });
    expect(preferred).not.toHaveAttribute("data-disabled");

    await user.click(within(card).getByRole("combobox", { name: "Chat API" }));
    await user.click(await screen.findByRole("option", { name: "Newer API (CreateResponse) New" }));
    expect(preferred).toHaveAttribute("data-disabled");

    await user.click(within(card).getByRole("combobox", { name: "Chat API" }));
    await user.click(
      await screen.findByRole("option", { name: "Older API (generateAssistantResponse)" }),
    );
    expect(preferred).not.toHaveAttribute("data-disabled");
  });

  it("keeps the endpoint choice it cannot use, so switching back restores it", async () => {
    const { card, user } = await renderCard({
      preferredEndpoint: "amazonq",
      endpointFallback: false,
      chatApi: "auto",
    });
    await user.click(within(card).getByRole("combobox", { name: "Chat API" }));
    await user.click(await screen.findByRole("option", { name: "Newer API (CreateResponse) New" }));
    await user.click(within(card).getByRole("button", { name: "Save" }));
    await screen.findByText("Saved");
    expect(await Promise.all(saved)).toEqual([
      { preferredEndpoint: "amazonq", endpointFallback: false, chatApi: "responses" },
    ]);
  });

  it("marks the newer chat API New, in the list and once picked", async () => {
    const { card, user } = await renderCard({
      preferredEndpoint: "kiro",
      endpointFallback: true,
      chatApi: "responses",
    });
    const trigger = within(card).getByRole("combobox", { name: "Chat API" });
    expect(trigger).toHaveTextContent("Newer API (CreateResponse) New");
    await user.click(trigger);
    expect(
      await screen.findByRole("option", { name: "Newer API (CreateResponse) New" }),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: "Automatic" })).toBeVisible();
  });
});
