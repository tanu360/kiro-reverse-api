import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { Card } from "@/components/ui/card";
import type { AccountActivityResponse } from "@/lib/api/account-activity";
import { EMPTY } from "@/lib/format";
import { mockDb, mockNowUnix } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { AccountActivityLine, LiveActivityStrip } from "./account-activity";

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
    expect(await screen.findByText("3 rpm · 1,234 today")).toBeInTheDocument();
    expect(
      screen.getByText(
        "3 requests finished in the last minute, 1,234 since midnight (server time).",
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
        /^At the limit of 20 requests per minute: new requests go to other accounts/,
      ),
    ).toBeInTheDocument();
  });

  it("holds the line with a dash while the first poll loads, and reads idle for an unlisted account", async () => {
    serve(activity({}));
    const view = renderWithProviders(<AccountActivityLine accountId="new" />);
    expect(view.container).toHaveTextContent(EMPTY);
    expect(await screen.findByText("0 rpm · 0 today")).toBeInTheDocument();
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
    expect(await screen.findByText(`${rpm} rpm · ${today} today`)).toBeInTheDocument();
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
    expect(screen.getByText("At limit")).toHaveAttribute("data-slot", "badge");
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
});
