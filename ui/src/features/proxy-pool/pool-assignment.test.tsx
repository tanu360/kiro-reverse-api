import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountDetailSheet } from "@/features/accounts/account-detail-sheet";
import type { ProxyPoolView } from "@/lib/api/proxy-pool";
import { mockDb } from "@/lib/mocks/db";
import { renderWithProviders } from "@/test/render";
import { resetProxyPoolMock, seedProxyPoolMock } from "./mocks";
import { PoolProxyValue } from "./pool-assignment";

const view: ProxyPoolView = {
  mode: "on",
  directFallback: false,
  checkIntervalMin: 10,
  maxFailures: 3,
  detected: [],
  counts: { healthy: 1, unhealthy: 0, autoDisabled: 1, off: 0, unknown: 0 },
  proxies: [
    {
      id: "px_1",
      label: "Frankfurt",
      url: "socks5://10.0.0.1:1080",
      hasPassword: true,
      enabled: true,
      state: "healthy",
      accounts: 1,
      health: { status: "ok", latencyMs: 120 },
    },
    {
      id: "px_2",
      url: "http://10.0.0.2:3128",
      hasPassword: false,
      enabled: true,
      state: "auto_disabled",
      accounts: 1,
      health: { status: "failed", failures: 3 },
    },
  ],
  assignments: { a1: "px_1", a2: "px_2" },
};

beforeEach(() => resetProxyPoolMock());

describe("PoolProxyValue", () => {
  it("shows the assigned proxy's label, status and a Pool badge", () => {
    renderWithProviders(<PoolProxyValue accountId="a1" view={view} />);
    expect(screen.getByText("Frankfurt")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Healthy" })).toBeInTheDocument();
    expect(screen.getByText("Pool")).toBeInTheDocument();
  });

  it("shows the address of a proxy without a label", () => {
    renderWithProviders(<PoolProxyValue accountId="a2" view={view} />);
    expect(screen.getByText("http://10.0.0.2:3128")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Auto-disabled" })).toBeInTheDocument();
  });

  it("says an account with no proxy yet gets one on its next request", () => {
    renderWithProviders(<PoolProxyValue accountId="a3" view={view} />);
    expect(screen.getByText("Assigned on the next request")).toBeInTheDocument();
    expect(screen.getByText("Pool")).toBeInTheDocument();
  });
});

describe("account detail", () => {
  it("shows the pool proxy of an account without its own while the pool is on", async () => {
    const account = mockDb.accounts.find((a) => !a.proxyURL);
    if (!account) throw new Error("fixture missing");
    seedProxyPoolMock({
      mode: "on",
      proxies: [
        {
          id: "px_a",
          label: "Tokyo",
          url: "socks5://10.1.0.1:1080",
          username: "u",
          password: "pool-secret",
          createdAt: 0,
          health: { status: "ok", latencyMs: 90 },
        },
      ],
      assignments: { [account.id]: "px_a" },
    });
    renderWithProviders(<AccountDetailSheet accountId={account.id} onOpenChange={() => {}} open />);
    const sheet = await screen.findByRole("dialog");
    const facts = await within(sheet).findByRole("region", { name: "Account" });
    expect(await within(facts).findByText("Tokyo")).toBeInTheDocument();
    expect(within(facts).getByText("Pool")).toBeInTheDocument();
    expect(within(facts).queryByText("Global")).not.toBeInTheDocument();
    expect(sheet).not.toHaveTextContent("pool-secret");
  });

  it("keeps the global proxy while the pool is off", async () => {
    const account = mockDb.accounts.find((a) => !a.proxyURL);
    if (!account) throw new Error("fixture missing");
    renderWithProviders(<AccountDetailSheet accountId={account.id} onOpenChange={() => {}} open />);
    const sheet = await screen.findByRole("dialog");
    const facts = await within(sheet).findByRole("region", { name: "Account" });
    expect(await within(facts).findByText("Global")).toBeInTheDocument();
    expect(within(facts).queryByText("Pool")).not.toBeInTheDocument();
  });
});
