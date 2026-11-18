import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { MetricsCard, maskMetricsToken, scrapeConfig } from "./metrics-card";

/** A line read out by the app's live region (announce()), not a visible notice. */
async function expectAnnounced(text: string): Promise<void> {
  const line = await screen.findByText(text);
  expect(line.closest('[data-slot="live-announcer"]')).not.toBeNull();
}

describe("MetricsCard", () => {
  it("is off until switched on, then shows the address, token and a scrape job", async () => {
    const { user } = renderWithProviders(<MetricsCard />);
    const toggle = await screen.findByRole("switch", { name: "Serve /metrics" });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByText("Bearer token")).not.toBeInTheDocument();
    await user.click(toggle);
    await waitFor(() => expect(mockDb.metrics.token).toMatch(/^kpm_[0-9a-f]{48}$/));
    expect(await screen.findByText("Bearer token")).toBeInTheDocument();
    // On one line, masked; the whole token is only what Copy copies.
    const token = mockDb.metrics.token;
    expect(maskMetricsToken(token)).toBe(`${token.slice(0, 8)}****${token.slice(-4)}`);
    expect(screen.getAllByText(maskMetricsToken(token), { exact: false }).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText(token, { exact: false })).not.toBeInTheDocument();
    expect(screen.getByText("prometheus.yml")).toBeInTheDocument();
    // Copy copies the whole token, alone and in the scrape job.
    await user.click(screen.getAllByRole("button", { name: "Copy" })[1] as HTMLElement);
    expect(await navigator.clipboard.readText()).toBe(token);
    await user.click(screen.getByRole("button", { name: "Copy scrape config" }));
    expect(await navigator.clipboard.readText()).toContain(`credentials: ${token}`);
  });

  it("makes a new token after a confirm", async () => {
    mockDb.metrics = { enabled: true, token: "kpm_old" };
    const { user } = renderWithProviders(<MetricsCard />);
    await user.click(await screen.findByRole("button", { name: "New token" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "New token" }));
    await waitFor(() => expect(mockDb.metrics.token).not.toBe("kpm_old"));
    await expectAnnounced("A new token was made.");
  });

  it("puts the switch back on a failed save, and Try again switches it", async () => {
    let fail = true;
    mockServer.use(
      http.post(apiUrl("/metrics"), () =>
        fail ? HttpResponse.json({ error: "store busy" }, { status: 500 }) : undefined,
      ),
    );
    const { user } = renderWithProviders(<MetricsCard />);
    const toggle = await screen.findByRole("switch", { name: "Serve /metrics" });

    await user.click(toggle);
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/^store busy$/);
    await waitFor(() => expect(toggle).not.toBeChecked());

    fail = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    await expectAnnounced("Your settings were saved.");
    await waitFor(() => expect(toggle).toBeChecked());
    expect(toggle).toHaveFocus();
    expect(mockDb.metrics.enabled).toBe(true);
  });

  it("writes a scrape job for the server's own address", () => {
    expect(scrapeConfig("https://kiro.example.com:8443", "/metrics", "kpm_x")).toContain(
      'targets: ["kiro.example.com:8443"]',
    );
    expect(scrapeConfig("http://127.0.0.1:8080", "/metrics", "kpm_x")).toContain("scheme: http");
  });
});
