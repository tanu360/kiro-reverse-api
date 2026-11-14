import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { renderWithProviders } from "@/test/render";
import { MetricsCard, scrapeConfig } from "./metrics-card";

describe("MetricsCard", () => {
  it("is off until switched on, then shows the address, token and a scrape job", async () => {
    const { user } = renderWithProviders(<MetricsCard />);
    const toggle = await screen.findByRole("switch", { name: "Serve /metrics" });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByText("Bearer token")).not.toBeInTheDocument();
    await user.click(toggle);
    await waitFor(() => expect(mockDb.metrics.token).toMatch(/^kpm_[0-9a-f]{48}$/));
    expect(await screen.findByText("Bearer token")).toBeInTheDocument();
    expect(screen.getAllByText(mockDb.metrics.token, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText("prometheus.yml")).toBeInTheDocument();
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
