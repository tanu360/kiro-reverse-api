import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RoutingMode } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { renderWithProviders } from "@/test/render";
import { RoutingCard } from "./routing-card";

async function renderWith(
  keyModes: Array<"inherit" | RoutingMode>,
  { required = true, linkOn = false, expired = false } = {},
) {
  mockDb.settings = { ...mockDb.settings, requireApiKey: required };
  mockDb.tunnel = { ...mockDb.tunnel, enabled: linkOn };
  mockDb.apiKeys = mockDb.apiKeys.map((key, i) => ({
    ...key,
    enabled: i < keyModes.length,
    expired,
    expiresAt: expired ? 1 : 0,
    routingMode: keyModes[i] ?? "inherit",
  }));
  renderWithProviders(<RoutingCard />);
  await screen.findByRole("radiogroup");
}

describe("RoutingModeRow and API keys' own routing modes", () => {
  it("counts the enabled API keys that route by a mode of their own", async () => {
    await renderWith(["priority", "inherit", "reset_first"]);
    expect(
      await screen.findByText("2 API keys use their own routing mode instead of this one."),
    ).toBeInTheDocument();
  });

  it("says nothing while every key follows this mode", async () => {
    await renderWith(["inherit"]);
    expect(screen.queryByText(/use(s)? (their|its) own routing mode/)).not.toBeInTheDocument();
  });

  it("says nothing while no request is checked for a key (proxy/auth.go authenticate)", async () => {
    await renderWith(["priority"], { required: false });
    expect(screen.queryByText(/use(s)? (their|its) own routing mode/)).not.toBeInTheDocument();
  });

  it("counts the keys while the public link is on, which always checks for one", async () => {
    await renderWith(["priority"], { required: false, linkOn: true });
    expect(
      await screen.findByText("1 API key uses its own routing mode instead of this one."),
    ).toBeInTheDocument();
  });

  it("leaves out an expired key: its clients get 401", async () => {
    await renderWith(["priority"], { expired: true });
    expect(screen.queryByText(/use(s)? (their|its) own routing mode/)).not.toBeInTheDocument();
  });
});
