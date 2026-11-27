import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetProxyPoolMock, seedProxyPoolMock } from "@/features/proxy-pool/mocks";
import { mockDb } from "@/lib/mocks/db";
import { renderWithProviders } from "@/test/render";
import { OutboundProxyCard } from "./outbound-proxy-card";

const POOL_PROXY = {
  id: "px_1",
  label: "Frankfurt",
  url: "socks5://10.0.0.1:1080",
  username: "",
  password: "",
  createdAt: 0,
  health: { status: "ok" as const, checkedAt: 0, latencyMs: 120 },
};

const PLAIN = "Send Kiro, sign-in and alert traffic through a SOCKS5, HTTP or HTTPS proxy.";
const POOL_FALLBACK = "as the fallback when no pool proxy is healthy";
const POOL_NO_FALLBACK = "The pool's fallback is off";

beforeEach(() => {
  mockDb.proxy.proxyURL = "socks5://127.0.0.1:1080";
  resetProxyPoolMock();
});

describe("OutboundProxyCard under the proxy pool", () => {
  it("names the fallback only while the pool's fallback is on", async () => {
    seedProxyPoolMock({ mode: "on", directFallback: true, proxies: [POOL_PROXY] });
    renderWithProviders(<OutboundProxyCard />);
    expect(await screen.findByText(new RegExp(POOL_FALLBACK))).toBeInTheDocument();
  });

  it("says the proxy is not used for requests while the pool's fallback is off", async () => {
    seedProxyPoolMock({ mode: "on", directFallback: false, proxies: [POOL_PROXY] });
    renderWithProviders(<OutboundProxyCard />);
    const hint = await screen.findByText(new RegExp(POOL_NO_FALLBACK));
    // Alerts go out on this proxy whatever the pool does (proxy/alerts_channels.go).
    expect(hint).toHaveTextContent("used for sign-in and alerts");
    expect(screen.queryByText(new RegExp(POOL_FALLBACK))).not.toBeInTheDocument();
  });

  it("keeps the plain hint while the pool is on but empty, as requests then use this proxy", async () => {
    seedProxyPoolMock({ mode: "on", directFallback: false });
    renderWithProviders(<OutboundProxyCard />);
    expect(await screen.findByText(new RegExp(PLAIN))).toBeInTheDocument();
  });
});

describe("OutboundProxyCard editor", () => {
  it("turns the password off until a username is typed, as the URL drops it without one", async () => {
    mockDb.proxy.proxyURL = "";
    const { user } = renderWithProviders(<OutboundProxyCard />);
    await user.click(await screen.findByRole("button", { name: "Set up proxy" }));
    const dialog = await screen.findByRole("dialog");
    const password = within(dialog).getByLabelText("Password");
    expect(password).toBeDisabled();
    expect(within(dialog).getByText("A password needs a username.")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Username"), "alice");
    expect(password).toBeEnabled();
    expect(within(dialog).queryByText("A password needs a username.")).not.toBeInTheDocument();
  });
});
