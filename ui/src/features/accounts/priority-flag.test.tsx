import { screen, waitFor } from "@testing-library/react";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import type { RoutingMode } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { makeAccount } from "@/lib/mocks/fixtures";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { AccountFlags } from "./account-cells";

async function renderFlags(mode: RoutingMode, showPriority = true) {
  mockDb.settings.routingMode = mode;
  const account = makeAccount({ weight: 3, priority: 7 });
  const view = renderWithProviders(<AccountFlags account={account} showPriority={showPriority} />);
  // The mode comes from GET /settings: wait until it has landed.
  await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
  return view;
}

describe("AccountFlags priority", () => {
  it("shows the priority, not the weight, in the priority mode", async () => {
    await renderFlags("priority");
    const label = await screen.findByText("Priority 7");
    expect(label).toHaveClass("sr-only");
    // The number is the pill's visible text; the label is what a screen reader hears.
    expect(label.parentElement).toHaveTextContent("7Priority 7");
    expect(label.parentElement).not.toHaveAttribute("tabindex");
    expect(screen.queryByText("Weight 3")).not.toBeInTheDocument();
  });

  it("keeps the weight and fetches no settings without showPriority (the Overview)", async () => {
    let settingsFetched = false;
    mockServer.use(
      http.get(apiUrl("/settings"), () => {
        settingsFetched = true;
        return undefined;
      }),
    );
    await renderFlags("priority", false);
    expect(screen.getByText("Weight 3")).toHaveClass("sr-only");
    expect(screen.queryByText("Priority 7")).not.toBeInTheDocument();
    expect(settingsFetched).toBe(false);
  });

  it("shows the weight and no priority in the weighted mode", async () => {
    await renderFlags("weighted");
    expect(screen.getByText("Weight 3")).toHaveClass("sr-only");
    expect(screen.queryByText("Priority 7")).not.toBeInTheDocument();
  });
});
