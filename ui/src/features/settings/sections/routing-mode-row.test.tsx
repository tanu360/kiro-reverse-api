import { screen, waitFor, within } from "@testing-library/react";
import { delay, HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { queryKeys } from "@/lib/api/query-keys";
import type { Settings } from "@/lib/api/types";
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

/** A line read out by the app's live region (announce()), not a visible notice. */
async function expectAnnounced(text: string): Promise<void> {
  const line = await screen.findByText(text);
  expect(line.closest('[data-slot="live-announcer"]')).not.toBeNull();
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
    expect(group).toHaveAccessibleDescription(/highest priority number/);
  });

  it("switches to Priority at once and sends only routingMode", async () => {
    const posts = capturePosts();
    const { user, group } = await renderCard();
    expect(screen.getByRole("radio", { name: "Weighted" })).toBeChecked();
    expect(group).toHaveAccessibleDescription(/rotate across the enabled accounts/);

    await user.click(screen.getByRole("radio", { name: "Priority" }));

    expect(screen.getByRole("radio", { name: "Priority" })).toBeChecked();
    await expectAnnounced("Your settings were saved.");
    expect(posts).toEqual([{ routingMode: "priority" }]);
    expect(mockDb.settings.routingMode).toBe("priority");
    expect(group).toHaveAccessibleDescription(/highest priority number/);
    // The affinity switch under it is untouched.
    expect(mockDb.settings.sessionAffinity).toBe(true);
  });

  it("offers Reset first with its own hint and saves it", async () => {
    const posts = capturePosts();
    const { user, group } = await renderCard();
    await user.click(screen.getByRole("radio", { name: "Reset first" }));
    expect(screen.getByRole("radio", { name: "Reset first" })).toBeChecked();
    await expectAnnounced("Your settings were saved.");
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

    // The reason only, under the row.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /^Choose a routing mode: weighted, priority or reset first\.$/,
    );
    await waitFor(() => expect(screen.getByRole("radio", { name: "Weighted" })).toBeChecked());
    expect(mockDb.settings.routingMode).toBe("weighted");
  });

  it("sends the same pick again from Try again, with focus back on the choice", async () => {
    let fail = true;
    mockServer.use(
      // A moment's latency, as on a real network: the pick shows while it saves.
      http.post(apiUrl("/settings"), async () => {
        if (fail) return HttpResponse.json({ error: "store busy" }, { status: 500 });
        await delay(50);
        return undefined;
      }),
    );
    const posts = capturePosts();
    const { user } = await renderCard();

    await user.click(screen.getByRole("radio", { name: "Priority" }));
    const notice = await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Weighted" })).toBeChecked());

    fail = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));

    await expectAnnounced("Your settings were saved.");
    expect(screen.getByRole("radio", { name: "Priority" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Priority" })).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(posts).toEqual([{ routingMode: "priority" }, { routingMode: "priority" }]);
    expect(mockDb.settings.routingMode).toBe("priority");
  });

  it("drops a failure once the server's saved mode changes", async () => {
    mockServer.use(
      http.post(apiUrl("/settings"), () =>
        HttpResponse.json({ error: "store busy" }, { status: 500 }),
      ),
    );
    const { user, queryClient } = await renderCard();

    await user.click(screen.getByRole("radio", { name: "Priority" }));
    await screen.findByRole("alert");
    // Another tab saved the same pick: Try again would do nothing, so the notice goes.
    queryClient.setQueryData<Settings>(queryKeys.settings.general(), (old) =>
      old ? { ...old, routingMode: "priority" } : old,
    );

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("radio", { name: "Priority" })).toBeChecked();
  });

  it("closes a failure with focus back on the choice", async () => {
    mockServer.use(
      http.post(apiUrl("/settings"), () =>
        HttpResponse.json({ error: "store busy" }, { status: 500 }),
      ),
    );
    const { user } = await renderCard();

    await user.click(screen.getByRole("radio", { name: "Priority" }));
    const notice = await screen.findByRole("alert");
    await user.click(within(notice).getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Weighted" })).toHaveFocus();
  });
});
