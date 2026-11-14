import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { renderWithProviders } from "@/test/render";
import { MetricsCard, maskMetricsToken, scrapeConfig } from "./metrics-card";

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
    expect(await screen.findAllByText("A new token was made.")).not.toHaveLength(0);
  });

  it("writes a scrape job for the server's own address", () => {
    expect(scrapeConfig("https://kiro.example.com:8443", "/metrics", "kpm_x")).toContain(
      'targets: ["kiro.example.com:8443"]',
    );
    expect(scrapeConfig("http://127.0.0.1:8080", "/metrics", "kpm_x")).toContain("scheme: http");
  });
});
