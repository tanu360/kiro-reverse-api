import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/ui/card";
import type { AccountActivityResponse } from "@/lib/api/account-activity";
import type { Account } from "@/lib/api/types";
import { EMPTY } from "@/lib/format";
import { mockDb, mockNowUnix } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { AccountActivityLine, LiveActivityStrip, LiveStatusPill } from "./account-activity";

function serve(body: AccountActivityResponse): void {
  mockServer.use(http.get(apiUrl("/observe/account-activity"), () => HttpResponse.json(body)));
}

function activity(
  accounts: AccountActivityResponse["accounts"],
  rpmLimit = 0,
): AccountActivityResponse {
  return { nowUnix: 1_800_000_000, dayStartUnix: 1_799_990_000, rpmLimit, accounts };
}

describe("AccountActivityLine", () => {
  it("shows the last minute and today for its own account", async () => {
    serve(
      activity({
        a: { today: 1234, rpm: 3, atLimit: false },
        b: { today: 9, rpm: 9, atLimit: false },
      }),
    );
    renderWithProviders(<AccountActivityLine accountId="a" />);
    expect(await screen.findByText("3/min · 1,234 today")).toBeInTheDocument();
    expect(
      screen.getByText(
        "3 requests finished in the last minute and 1,234 since midnight (server time).",
      ),
    ).toHaveClass("sr-only");
  });

  it("says At limit, with the limit in its sentence, while the pool skips the account", async () => {
    serve(activity({ a: { today: 42, rpm: 18, atLimit: true } }, 20));
    renderWithProviders(<AccountActivityLine accountId="a" />);
    expect(await screen.findByText("At limit")).toBeInTheDocument();
    expect(screen.getByText(/42 today/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /^This account is at its limit of 20 requests per minute\. Every attempt sent to it counts, including failed ones/,
      ),
    ).toBeInTheDocument();
  });

  it("uses the singular for one request in the line's sentence", async () => {
    serve(activity({ a: { today: 1, rpm: 1, atLimit: true } }, 1));
    renderWithProviders(<AccountActivityLine accountId="a" />);
    expect(
      await screen.findByText(
        /^This account is at its limit of 1 request per minute\..* 1 request finished in the last minute and 1 since midnight/,
      ),
    ).toHaveClass("sr-only");
  });

  it("holds the line with a dash while the first poll loads, and reads idle for an unlisted account", async () => {
    serve(activity({}));
    const view = renderWithProviders(<AccountActivityLine accountId="new" />);
    expect(view.container).toHaveTextContent(EMPTY);
    expect(await screen.findByText("0/min · 0 today")).toBeInTheDocument();
  });

  it("shows nothing when the poll fails", async () => {
    mockServer.use(
      http.get(apiUrl("/observe/account-activity"), () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    const view = renderWithProviders(<AccountActivityLine accountId="a" />);
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
  });

  it("counts the mock request log's last minute and today", async () => {
    const account = mockDb.accounts[0];
    const template = mockDb.requests[0];
    if (!account || !template) throw new Error("fixture missing");
    const now = mockNowUnix();
    const times = [now - 5, now - 30, now - 61];
    mockDb.requests = times.map((ts) => ({ ...template, accountId: account.id, ts }));
    const midnight = new Date(now * 1000);
    midnight.setHours(0, 0, 0, 0);
    const today = times.filter((ts) => ts >= midnight.getTime() / 1000).length;
    const rpm = times.filter((ts) => ts > now - 60).length;

    renderWithProviders(<AccountActivityLine accountId={account.id} />);
    expect(await screen.findByText(`${rpm}/min · ${today} today`)).toBeInTheDocument();
  });
});

describe("LiveActivityStrip", () => {
  it("shows today and the last minute against the limit, with the At limit pill", async () => {
    serve(activity({ a: { today: 42, rpm: 20, atLimit: true } }, 20));
    renderWithProviders(
      <Card className="@container">
        <LiveActivityStrip accountId="a" />
      </Card>,
    );
    expect(await screen.findByText("20 / 20")).toBeInTheDocument();
    expect(screen.getByText("Requests today")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("Requests per minute")).toBeInTheDocument();
    // The pill is a button: its hint opens on tap and from the keyboard, not only on hover.
    expect(screen.getByRole("button", { name: /^At limit/ })).toBeInTheDocument();
  });

  it("explains in the pill why a minute with no finished request can be at the limit", async () => {
    serve(activity({ a: { today: 4, rpm: 0, atLimit: true } }, 1));
    renderWithProviders(
      <Card className="@container">
        <LiveActivityStrip accountId="a" />
      </Card>,
    );
    expect(await screen.findByText("0 / 1")).toBeInTheDocument();
    const hint = screen.getByText(
      /^This account is at its limit of 1 request per minute\. Every attempt sent to it counts, including failed ones that moved on to another account\./,
    );
    expect(hint).toHaveClass("sr-only");
    expect(screen.getByRole("button", { name: /^At limit/ })).toContainElement(hint);
  });

  it("shows the bare count when no limit is set", async () => {
    serve(activity({ a: { today: 5, rpm: 2, atLimit: false } }));
    renderWithProviders(
      <Card className="@container">
        <LiveActivityStrip accountId="a" />
      </Card>,
    );
    expect(await screen.findByText("2")).toBeInTheDocument();
    expect(screen.queryByText("At limit")).not.toBeInTheDocument();
    expect(screen.queryByText(/\//)).not.toBeInTheDocument();
  });

  it("says Cooling down with the time left while the pool skips the account after errors", async () => {
    serve(activity({ a: { today: 7, rpm: 0, atLimit: false, cooldownUntil: 1_800_000_045 } }, 0));
    renderWithProviders(
      <Card className="@container">
        <LiveActivityStrip accountId="a" />
      </Card>,
    );
    const pill = await screen.findByRole("button", { name: /^Cooling down/ });
    expect(pill).toHaveTextContent(/back in rotation in 45s/);
  });
});

describe("account hold hints", () => {
  it("opens the At limit hint with a tap and from the keyboard", async () => {
    const user = userEvent.setup();
    serve(activity({ a: { today: 1, rpm: 1, atLimit: true } }, 1));
    renderWithProviders(<AccountActivityLine accountId="a" />);
    const trigger = await screen.findByRole("button", { name: "At limit" });
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      /^This account is at its limit of 1 request per minute\./,
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(trigger);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("keeps a tap on the hint from reaching the row under it", async () => {
    const user = userEvent.setup();
    let opened = 0;
    serve(activity({ a: { today: 3, rpm: 0, atLimit: false, cooldownUntil: 1_800_000_090 } }));
    renderWithProviders(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for a table row's click
      // biome-ignore lint/a11y/useKeyWithClickEvents: stands in for a table row's click
      <div onClick={() => opened++}>
        <LiveStatusPill account={activeAccount("a")} size="sm" />
        <AccountActivityLine accountId="a" />
      </div>,
    );
    await user.click(await screen.findByRole("button", { name: /^Cooling down/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(/1m 30s/);
    expect(opened).toBe(0);
    expect(screen.getByText(/3 today/)).toBeInTheDocument();
  });
});

function activeAccount(id: string, patch: Partial<Account> = {}): Account {
  const base = mockDb.accounts.find((account) => account.enabled && account.hasToken);
  if (!base) throw new Error("fixture missing");
  return {
    ...base,
    id,
    banStatus: "",
    banReason: "",
    expiresAt: 4_000_000_000,
    usageCurrent: 0,
    usageLimit: 50,
    ...patch,
  };
}

describe("a cooling account", () => {
  const cooling = activity({
    a: { today: 43, rpm: 0, atLimit: false, cooldownUntil: 1_800_000_045 },
  });

  it("reads Cooling down in its pill, not Active, with the time left in the hint", async () => {
    serve(cooling);
    renderWithProviders(<LiveStatusPill account={activeAccount("a")} size="sm" />);
    const pill = await screen.findByRole("button", { name: /^Cooling down/ });
    expect(pill).toHaveTextContent(/back in rotation in 45s/);
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });

  it("puts the time left in the line under the pill, not a second Cooling down", async () => {
    serve(cooling);
    renderWithProviders(<AccountActivityLine accountId="a" />);
    expect(await screen.findByText("45s left")).toBeInTheDocument();
    expect(screen.getByText("43 today")).toBeInTheDocument();
    expect(screen.queryByText("Cooling down")).not.toBeInTheDocument();
  });

  it("reads Active again once the cooldown is over", async () => {
    serve(activity({ a: { today: 43, rpm: 1, atLimit: false, cooldownUntil: 1_799_999_990 } }));
    renderWithProviders(
      <>
        <LiveStatusPill account={activeAccount("a")} size="sm" />
        <AccountActivityLine accountId="a" />
      </>,
    );
    expect(await screen.findByText("1/min · 43 today")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("keeps a stronger status than Active, such as Disabled", async () => {
    serve(cooling);
    renderWithProviders(
      <>
        <LiveStatusPill account={activeAccount("a", { enabled: false })} size="sm" />
        <AccountActivityLine accountId="a" />
      </>,
    );
    expect(await screen.findByText("45s left")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Cooling down/ })).not.toBeInTheDocument();
  });
});
