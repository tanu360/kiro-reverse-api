import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { resetProxyPoolMock, seedProxyPoolMock } from "./mocks";
import { ProxyPoolCard } from "./proxy-pool-card";

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

let recorded: Array<Promise<Recorded>> = [];

function onRequestStart({ request }: { request: Request }): void {
  const path = new URL(request.url).pathname.replace(/^\/admin\/api/, "");
  recorded.push(
    request
      .clone()
      .text()
      .then((text) => ({ method: request.method, path, body: text ? JSON.parse(text) : null })),
  );
}

/** Every pool write the card sent, in order. */
async function writes(): Promise<Recorded[]> {
  const all = await Promise.all(recorded);
  return all.filter((r) => r.method !== "GET");
}

const frankfurt = {
  id: "px_1",
  label: "Frankfurt",
  url: "socks5://10.0.0.1:1080",
  username: "bob",
  password: "s3cret-pool-pass",
  createdAt: 0,
  health: { status: "ok" as const, checkedAt: Date.now() - 60_000, latencyMs: 142 },
};

beforeEach(() => {
  resetProxyPoolMock();
  recorded = [];
  mockServer.events.on("request:start", onRequestStart);
});

afterEach(() => {
  mockServer.events.removeListener("request:start", onRequestStart);
});

async function renderCard() {
  const result = renderWithProviders(<ProxyPoolCard />);
  await screen.findByRole("switch", { name: "Use the proxy pool" });
  return result;
}

describe("ProxyPoolCard", () => {
  it("starts empty, with the pool switch off until a proxy is added", async () => {
    await renderCard();
    expect(screen.getByText(/No proxies yet/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Use the proxy pool" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.queryByRole("button", { name: "Check all" })).not.toBeInTheDocument();
  });

  it("lists a proxy with its status, latency and load, and never its password", async () => {
    seedProxyPoolMock({ proxies: [frankfurt], assignments: { a1: "px_1", a2: "px_1" } });
    const { container } = await renderCard();
    expect(await screen.findByText("Frankfurt")).toBeInTheDocument();
    expect(screen.getByText("socks5://10.0.0.1:1080")).toBeInTheDocument();
    expect(screen.getByText("Signs in as bob")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("2 accounts")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("s3cret-pool-pass");
  });

  it("adds a proxy with its credentials as their own fields", async () => {
    const { user } = await renderCard();
    await user.click(screen.getByRole("button", { name: "Add proxy" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Label/), "Home");
    await user.type(within(dialog).getByLabelText("Host"), "proxy.local");
    await user.type(within(dialog).getByLabelText("Port"), "1080");
    await user.type(within(dialog).getByLabelText("Username"), "alice");
    await user.type(within(dialog).getByLabelText("Password"), "pw");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Home")).toBeInTheDocument();
    expect(await writes()).toEqual([
      {
        method: "POST",
        path: "/proxy-pool/proxies",
        body: {
          label: "Home",
          url: "socks5://proxy.local:1080",
          username: "alice",
          password: "pw",
        },
      },
    ]);
    expect(screen.getByRole("switch", { name: "Use the proxy pool" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("keeps the saved password when an edit leaves the field empty", async () => {
    seedProxyPoolMock({ proxies: [frankfurt] });
    const { user } = await renderCard();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Password")).toHaveValue("");
    expect(within(dialog).getByText("Leave empty to keep the saved password.")).toBeInTheDocument();
    const label = within(dialog).getByLabelText(/^Label/);
    await user.clear(label);
    await user.type(label, "Berlin");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Berlin")).toBeInTheDocument();
    const [put] = await writes();
    expect(put.method).toBe("PUT");
    expect(put.path).toBe("/proxy-pool/proxies/px_1");
    expect(put.body).not.toHaveProperty("password");
  });

  it("checks every proxy and shows the failed one's error", async () => {
    const dead = {
      ...frankfurt,
      id: "px_2",
      label: "",
      url: "http://127.0.0.1:9",
      username: "",
      password: "",
    };
    seedProxyPoolMock({ proxies: [{ ...frankfurt, health: { status: "unknown" } }, dead] });
    const { user } = await renderCard();
    await user.click(await screen.findByRole("button", { name: "Check all" }));

    expect(await screen.findByText("Every proxy was checked.")).toBeInTheDocument();
    expect(await screen.findByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(
      screen.getByText("Last error: The proxy refused the connection.", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/proxyconnect/)).not.toBeInTheDocument();
  });

  it("words a failed test from its code and keeps the server's text behind Details", async () => {
    const dead = { ...frankfurt, id: "px_2", label: "Dead", url: "http://127.0.0.1:9" };
    seedProxyPoolMock({ proxies: [dead] });
    const { user } = await renderCard();
    await user.click(await screen.findByRole("button", { name: "Test" }));

    // The toast and its live-region copy.
    expect(
      await screen.findAllByText("Dead is not reachable. The proxy refused the connection."),
    ).not.toHaveLength(0);
    expect(
      await screen.findByText(/^Last error: The proxy refused the connection\./),
    ).toBeVisible();
    // Details opens on a click or tap as well as on hover, and keyboard focus reaches it.
    const details = screen.getByRole("button", { name: "Details" });
    await user.click(details);
    expect(await screen.findByText(/proxyconnect tcp: connect: connection refused/)).toBeVisible();
    expect(details.tabIndex).toBe(0);
  });

  it.each([
    [{ errorCode: "tunnel", errorStatus: 502 }, "The proxy answered with HTTP 502."],
    [{ errorCode: "auth", errorStatus: 407 }, "The proxy rejected the username or password."],
    [
      { errorCode: "auth_required", errorStatus: 407 },
      "The proxy asks for a username and password.",
    ],
    [{ errorCode: "timeout" }, "Connection timed out."],
    [{ errorCode: "dns" }, "Could not resolve the proxy host."],
    [{ errorCode: "something_new" }, "The connection through the proxy failed."],
    [{}, "The connection through the proxy failed."],
  ])("words the last error %o", async (code, sentence) => {
    const health = { status: "failed" as const, lastError: "raw text: boom", ...code };
    seedProxyPoolMock({ proxies: [{ ...frankfurt, health }] });
    await renderCard();
    expect(
      await screen.findByText(`Last error: ${sentence}`, { exact: false }),
    ).toBeInTheDocument();
  });

  it("turns the pool on as the switch flips", async () => {
    seedProxyPoolMock({ proxies: [frankfurt] });
    const { user } = await renderCard();
    const toggle = screen.getByRole("switch", { name: "Use the proxy pool" });
    await user.click(toggle);

    expect(await screen.findByText("Your settings were saved.")).toBeInTheDocument();
    await waitFor(() => expect(toggle).toBeChecked());
    expect(await writes()).toEqual([
      { method: "PUT", path: "/proxy-pool/settings", body: { mode: "on" } },
    ]);
  });

  it("removes a proxy after a confirm", async () => {
    seedProxyPoolMock({ proxies: [frankfurt] });
    const { user } = await renderCard();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("The proxy was removed.")).toBeInTheDocument();
    expect(await screen.findByText(/No proxies yet/)).toBeInTheDocument();
  });
});
