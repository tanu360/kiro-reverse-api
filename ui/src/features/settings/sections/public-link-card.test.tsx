import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { renderWithProviders } from "@/test/render";
import { PublicLinkCard } from "./public-link-card";

const LINK = "https://kiro-proxy.tail1234.ts.net";

describe("PublicLinkCard", () => {
  it("is off with only the switch and the device name", async () => {
    renderWithProviders(<PublicLinkCard />);
    const toggle = await screen.findByRole("switch", { name: "Public HTTPS link" });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByText("Status")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Device name" })).toHaveValue("kiro-proxy");
    expect(
      screen.getByText("Your link becomes https://kiro-proxy.<tailnet>.ts.net."),
    ).toBeVisible();
  });

  it("starts the helper download when switched on", async () => {
    const { user } = renderWithProviders(<PublicLinkCard />);
    await user.click(await screen.findByRole("switch", { name: "Public HTTPS link" }));
    await waitFor(() => expect(mockDb.tunnel.enabled).toBe(true));
    expect(await screen.findByText(/Downloading the Tailscale helper/)).toBeInTheDocument();
  });

  it("links to Tailscale's sign-in page while it waits for a sign-in", async () => {
    mockDb.tunnel.pinned = {
      enabled: true,
      state: "needs-login",
      authURL: "https://login.tailscale.com/a/abc123",
    };
    renderWithProviders(<PublicLinkCard />);
    expect(await screen.findByText("Sign in to Tailscale to get your link.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Sign in to Tailscale" });
    expect(link).toHaveAttribute("href", "https://login.tailscale.com/a/abc123");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows the live link with Copy and Open", async () => {
    mockDb.twoFactor.enabled = true;
    mockDb.tunnel.pinned = { enabled: true, signedIn: true, state: "running", url: LINK };
    const { user } = renderWithProviders(<PublicLinkCard />);
    expect(await screen.findByText("Live")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Link" })).toHaveTextContent(LINK);
    expect(screen.getByRole("link", { name: "Open link" })).toHaveAttribute("href", LINK);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(LINK);
  });

  it("warns while on without two-factor sign-in or an API key", async () => {
    mockDb.twoFactor.enabled = false;
    mockDb.apiKeys = [];
    mockDb.tunnel.pinned = { enabled: true, state: "running", url: LINK };
    renderWithProviders(<PublicLinkCard />);
    expect(
      await screen.findByText("Turn on two-factor sign-in before you share the link."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Public API calls need an API key. Create one on the API page."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open API page" })).toHaveAttribute("href", "/api");
  });

  it("refuses a device name that starts with a hyphen, and saves a good one on Enter", async () => {
    const { user } = renderWithProviders(<PublicLinkCard />);
    const field = await screen.findByRole("textbox", { name: "Device name" });
    await user.clear(field);
    await user.type(field, "-Kiro Home");
    // Capitals are lowered and the space is dropped as typed.
    expect(field).toHaveValue("-kirohome");
    await user.tab();
    expect(
      await screen.findByText(
        "Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.",
      ),
    ).toBeInTheDocument();
    expect(mockDb.tunnel.hostname).toBe("kiro-proxy");

    await user.clear(field);
    await user.type(field, "kiro-home{Enter}");
    await waitFor(() => expect(mockDb.tunnel.hostname).toBe("kiro-home"));
  });

  it("signs out of Tailscale after a confirm", async () => {
    mockDb.twoFactor.enabled = true;
    mockDb.tunnel.signedIn = true;
    mockDb.tunnel.pinned = { enabled: true, signedIn: true, state: "running", url: LINK };
    const { user } = renderWithProviders(<PublicLinkCard />);
    await user.click(await screen.findByRole("button", { name: "Sign out of Tailscale" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Sign out of Tailscale?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Sign out of Tailscale" }));
    await waitFor(() => expect(mockDb.tunnel.signedIn).toBe(false));
    expect(mockDb.tunnel.enabled).toBe(false);
    expect(await screen.findAllByText("Signed out of Tailscale.")).not.toHaveLength(0);
  });

  it("asks first when turned off from a page opened through the link", async () => {
    mockDb.tunnel.enabled = true;
    mockDb.tunnel.pinned = {
      enabled: true,
      state: "running",
      url: window.location.origin,
    };
    const { user } = renderWithProviders(<PublicLinkCard />);
    await user.click(await screen.findByRole("switch", { name: "Public HTTPS link" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Turn off the public link?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(mockDb.tunnel.enabled).toBe(false));
  });
});
