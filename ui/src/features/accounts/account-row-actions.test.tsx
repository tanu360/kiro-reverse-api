import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { AccountRowActions } from "./account-row-actions";

describe("AccountRowActions (card menu)", () => {
  it("keeps the menu reachable while a token refresh runs; only Refresh token waits", async () => {
    const [account] = mockDb.accounts;
    let release: () => void = () => {};
    mockServer.use(
      http.post(apiUrl("/accounts/:id/refresh"), async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json({ success: true });
      }),
    );
    const onDetails = vi.fn();
    const { user } = renderWithProviders(
      <AccountRowActions account={account} onDetails={onDetails} onTest={vi.fn()} variant="menu" />,
    );

    const trigger = screen.getByRole("button", { name: "More actions" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Refresh token" }));
    await waitFor(() => expect(trigger).toHaveAttribute("aria-busy", "true"));
    // Busy, not loading: the trigger keeps its name and stays enabled.
    expect(trigger).not.toHaveAttribute("aria-disabled");
    expect(trigger).not.toBeDisabled();

    // The keyboard still opens the menu mid-refresh.
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "Refresh token" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const details = screen.getByRole("menuitem", { name: "Details" });
    expect(details).not.toHaveAttribute("aria-disabled");
    await user.click(details);
    expect(onDetails).toHaveBeenCalledWith(account);

    release();
    await waitFor(() => expect(trigger).not.toHaveAttribute("aria-busy"));
  });
});
