import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { RoutingCard } from "./routing-card";

/** Records every POST /settings body, then lets the shared mock answer it. */
function capturePosts(): unknown[] {
  const bodies: unknown[] = [];
  mockServer.use(
    http.post(apiUrl("/settings"), async ({ request }) => {
      bodies.push(await request.clone().json());
      return undefined;
    }),
  );
  return bodies;
}

async function renderCard() {
  const view = renderWithProviders(<RoutingCard />);
  const group = await screen.findByRole("radiogroup", { name: "Routing mode" });
  return { ...view, group };
}

describe("RoutingModeRow", () => {
  it("shows the saved mode with its hint", async () => {
    mockDb.settings.routingMode = "priority";
    const { group } = await renderCard();
    expect(screen.getByRole("radio", { name: "Priority" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Weighted" })).not.toBeChecked();
    expect(group).toHaveAccessibleDescription(/lowest priority number/);
  });

  it("switches to Priority at once and sends only routingMode", async () => {
    const posts = capturePosts();
    const { user, group } = await renderCard();
    expect(screen.getByRole("radio", { name: "Weighted" })).toBeChecked();
    expect(group).toHaveAccessibleDescription(/rotate across the enabled accounts/);

    await user.click(screen.getByRole("radio", { name: "Priority" }));

    expect(screen.getByRole("radio", { name: "Priority" })).toBeChecked();
    expect(await screen.findByText("Your settings were saved.")).toBeInTheDocument();
    expect(posts).toEqual([{ routingMode: "priority" }]);
    expect(mockDb.settings.routingMode).toBe("priority");
    expect(group).toHaveAccessibleDescription(/lowest priority number/);
    // The affinity switch under it is untouched.
    expect(mockDb.settings.sessionAffinity).toBe(true);
  });

  it("offers Reset first with its own hint and saves it", async () => {
    const posts = capturePosts();
    const { user, group } = await renderCard();
    await user.click(screen.getByRole("radio", { name: "Reset first" }));
    expect(screen.getByRole("radio", { name: "Reset first" })).toBeChecked();
    expect(await screen.findByText("Your settings were saved.")).toBeInTheDocument();
    expect(posts).toEqual([{ routingMode: "reset_first" }]);
    expect(mockDb.settings.routingMode).toBe("reset_first");
    expect(group).toHaveAccessibleDescription(/credits reset soonest/);
  });

  it("shows a saved reset-first mode", async () => {
    mockDb.settings.routingMode = "reset_first";
    await renderCard();
    expect(screen.getByRole("radio", { name: "Reset first" })).toBeChecked();
  });

  it("puts the choice back when the save fails", async () => {
    mockServer.use(
      http.post(apiUrl("/settings"), () =>
        HttpResponse.json(
          {
            error: 'routingMode must be "weighted", "priority" or "reset_first"',
            code: "routing_mode_invalid",
          },
          { status: 400 },
        ),
      ),
    );
    const { user } = await renderCard();

    await user.click(screen.getByRole("radio", { name: "Priority" }));

    // The toast and its live-region copy.
    expect(
      await screen.findAllByText(
        "Could not save settings: Choose a routing mode: weighted, priority or reset first.",
      ),
    ).not.toHaveLength(0);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Weighted" })).toBeChecked());
    expect(mockDb.settings.routingMode).toBe("weighted");
  });
});
