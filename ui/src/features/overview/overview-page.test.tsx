import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { buildStatus } from "@/lib/mocks/fixtures";
import { apiUrl, jsonError } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp } from "@/test/render";

// /observe/recent-requests belongs to the Requests feature's mocks.
beforeEach(() => {
  mockServer.use(
    http.get(apiUrl("/observe/recent-requests"), ({ request }) => {
      const pageSize = Number(new URL(request.url).searchParams.get("pageSize") ?? 25);
      return HttpResponse.json({
        requests: mockDb.requests.slice(0, pageSize),
        total: mockDb.requests.length,
        page: 1,
        pageSize,
        sort: "time",
        order: "desc",
        persistent: true,
      });
    }),
  );
});

async function statCard(label: string): Promise<HTMLElement> {
  const region = await screen.findByRole("region", { name: "Totals" });
  const title = await within(region).findByText(label, { selector: "p" });
  const card = title.closest<HTMLElement>('[data-slot="stat-card"]');
  if (!card) throw new Error(`no stat card for ${label}`);
  return card;
}

function metricValue(card: HTMLElement, label: string): string {
  const term = within(card).getByText(label);
  return term.closest("div")?.querySelector("dd")?.textContent ?? "";
}

function errorsTable(): Promise<HTMLElement> {
  return screen.findByRole("table", { name: "Recent errors" });
}

describe("OverviewPage", () => {
  it("shows the four status cards with values from /status", async () => {
    await renderApp("/");
    const status = buildStatus(mockDb);

    const accounts = await statCard("Accounts");
    expect(within(accounts).getByText(String(mockDb.accounts.length))).toBeInTheDocument();
    expect(metricValue(accounts, "Available")).toBe(`${status.available} / ${status.accounts}`);

    const failed = await statCard("Failed");
    expect(metricValue(failed, "Unavailable")).toBe(String(status.accounts - status.available));

    expect(await statCard("Requests")).toBeInTheDocument();
    expect(await statCard("Succeeded")).toBeInTheDocument();
  });

  it("shows the SSE state in the live badge", async () => {
    await renderApp("/");
    // Vitest has no EventSource, so the events provider stays closed.
    expect(await screen.findByText("Offline")).toBeInTheDocument();
  });

  it("shows six live tiles and the 5-minute error rate as a percentage", async () => {
    const { container } = await renderApp("/");
    await waitFor(() => {
      expect(container.querySelectorAll('[data-slot="live-tile"]')).toHaveLength(6);
    });
    const errRate = container.querySelector<HTMLElement>('[data-tile="errRate"]');
    expect(errRate).not.toBeNull();
    expect(within(errRate as HTMLElement).getByText("Errors (5 min)")).toBeInTheDocument();
    expect(errRate?.querySelector("dd")?.textContent).toMatch(/^\d+\.\d%$/);
  });

  it("lists at most 10 recent errors", async () => {
    await renderApp("/");
    const table = await errorsTable();
    await waitFor(() => {
      expect(within(table).getAllByRole("row").length).toBeGreaterThan(1);
    });
    // The header row plus at most 10 data rows.
    expect(within(table).getAllByRole("row").length).toBeLessThanOrEqual(11);
    expect(mockDb.errors.length).toBeGreaterThan(10);
  });

  it("masks every email with privacy on", async () => {
    await renderApp("/", { privacy: true });
    const table = await errorsTable();
    await waitFor(() => {
      expect(within(table).getAllByRole("row").length).toBeGreaterThan(1);
    });
    const heatmap = await screen.findByRole("region", { name: "Traffic by account" });
    await within(heatmap).findByText("All accounts");
    const html = document.body.innerHTML;
    // API-key accounts carry a label instead of an address; privacy mode masks only addresses.
    const emails = mockDb.accounts.map((a) => a.email).filter((email) => email.includes("@"));
    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) {
      expect(html).not.toContain(email);
    }
  });

  it("shows the full email with privacy off", async () => {
    await renderApp("/", { privacy: false });
    const table = await errorsTable();
    const email = mockDb.errors[0].email as string;
    await waitFor(() => {
      expect(within(table).getAllByText(email).length).toBeGreaterThan(0);
    });
  });

  it("links the recent errors to the failed requests", async () => {
    await renderApp("/");
    const link = await screen.findByRole("link", { name: "View all in Requests" });
    expect(link).toHaveAttribute("href", "/admin/requests?status=failed");
  });

  it("writes the traffic range to the router search", async () => {
    const { user, router } = await renderApp("/");
    await user.click(await screen.findByRole("combobox", { name: "Time range" }));
    await user.click(await screen.findByRole("option", { name: "6 h" }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ range: "6h" });
    });
    expect(await screen.findByText("Requests per 5 min, last 6 h")).toBeInTheDocument();
  });

  it("shows a model-mix load failure only in that card", async () => {
    mockServer.use(
      http.get(apiUrl("/observe/model-mix"), () => jsonError(500, "model mix exploded")),
    );
    await renderApp("/");
    const modelMix = await screen.findByRole("region", { name: "Model mix" });
    expect(await within(modelMix).findByRole("alert")).toBeInTheDocument();
    expect(within(modelMix).getByRole("button", { name: "Try again" })).toBeInTheDocument();

    expect(await statCard("Accounts")).toBeInTheDocument();
    const heatmap = screen.getByRole("region", { name: "Traffic by account" });
    expect(await within(heatmap).findByText("All accounts")).toBeInTheDocument();
    expect(within(heatmap).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("recovers the status cards with Retry after /status fails", async () => {
    mockServer.use(
      http.get(apiUrl("/status"), () => jsonError(500, "status exploded"), { once: true }),
    );
    const { user } = await renderApp("/");
    const region = await screen.findByRole("region", { name: "Totals" });
    expect(await within(region).findByRole("alert")).toBeInTheDocument();

    await user.click(within(region).getByRole("button", { name: "Try again" }));
    expect(await statCard("Accounts")).toBeInTheDocument();
    const recovered = screen.getByRole("region", { name: "Totals" });
    expect(within(recovered).queryByRole("alert")).not.toBeInTheDocument();
  });
});
