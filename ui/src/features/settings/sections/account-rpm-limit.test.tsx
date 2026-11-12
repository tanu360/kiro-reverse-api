import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { RoutingCard } from "./routing-card";

let writes: unknown[] = [];

function onRequestStart({ request }: { request: Request }): void {
  if (request.method !== "POST" || !request.url.endsWith("/settings")) return;
  void request
    .clone()
    .json()
    .then((body: unknown) => writes.push(body));
}

beforeEach(() => {
  writes = [];
  mockServer.events.on("request:start", onRequestStart);
});

afterEach(() => {
  mockServer.events.removeListener("request:start", onRequestStart);
});

async function renderCard() {
  const view = renderWithProviders(<RoutingCard />);
  const toggle = await screen.findByRole("switch", { name: "Limit requests per account" });
  const input = screen.getByLabelText("Requests per minute");
  return { ...view, toggle, input };
}

describe("Routing card RPM limit", () => {
  it("is off by default with the number field disabled and no Save pending", async () => {
    const { toggle, input } = await renderCard();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");
  });

  it("drafts 20 when switched on and saves it as accountRpmLimit", async () => {
    const { user, toggle, input } = await renderCard();

    await user.click(toggle);
    expect(input).toBeEnabled();
    expect(input).toHaveValue("20");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Your settings were saved.")).toBeInTheDocument();
    await waitFor(() => expect(writes).toEqual([{ accountRpmLimit: 20 }]));
    expect(mockDb.settings.accountRpmLimit).toBe(20);
  });

  it("shows a field error for 1001 and sends nothing", async () => {
    const { user, toggle, input } = await renderCard();

    await user.click(toggle);
    await user.clear(input);
    await user.type(input, "1001");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Requests per minute must be a whole number between 1 and 1000."),
    ).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(writes).toEqual([]);
  });

  it("keeps the switch on when 0 is typed, and marks the field instead of saving", async () => {
    const { user, toggle, input } = await renderCard();

    await user.click(toggle);
    await user.clear(input);
    await user.type(input, "0");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(input).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Requests per minute must be a whole number between 1 and 1000."),
    ).toBeInTheDocument();
    expect(writes).toEqual([]);

    // Off and on again offers the default rather than the typed 0.
    await user.click(toggle);
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(input).toHaveValue("20");
  });

  it("saves 0 when a set limit is switched off, and keeps the number for later", async () => {
    mockDb.settings.accountRpmLimit = 45;
    const { user, toggle, input } = await renderCard();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(input).toHaveValue("45");

    await user.click(toggle);
    expect(input).toBeDisabled();
    expect(input).toHaveValue("45");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writes).toEqual([{ accountRpmLimit: 0 }]));
    expect(mockDb.settings.accountRpmLimit).toBe(0);
  });

  it("keeps session affinity an instant switch next to the limit", async () => {
    const { user } = await renderCard();
    await user.click(screen.getByRole("switch", { name: "Keep conversations on one account" }));
    await waitFor(() => expect(writes).toEqual([{ sessionAffinity: false }]));
    expect(mockDb.settings.sessionAffinity).toBe(false);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");
  });
});
