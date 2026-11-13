import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  ApiKeyUsageEntry,
  ApiKeyUsageKind,
  ApiKeyUsageResponse,
  ApiKeyUsageTotals,
} from "@/lib/api/api-key-usage";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { KeyUsageCard } from "./key-usage-card";
import { EMPTY_TOTALS } from "./key-usage-model";

function totals(partial: Partial<ApiKeyUsageTotals>): ApiKeyUsageTotals {
  const merged = { ...EMPTY_TOTALS, ...partial };
  return {
    ...merged,
    succeeded: merged.requests - merged.failed,
    tokens: merged.inTokens + merged.outTokens,
  };
}

function entry(
  id: string,
  kind: ApiKeyUsageKind,
  partial: Partial<ApiKeyUsageTotals>,
  extra: Partial<ApiKeyUsageEntry> = {},
): ApiKeyUsageEntry {
  const sum = totals(partial);
  return { id, kind, totals: sum, series: [EMPTY_TOTALS, sum], ...extra };
}

function usage(keys: ApiKeyUsageEntry[], range: ApiKeyUsageResponse["range"] = "24h") {
  const sum = keys.reduce(
    (acc, item) =>
      totals({
        requests: acc.requests + item.totals.requests,
        failed: acc.failed + item.totals.failed,
        credits: acc.credits + item.totals.credits,
      }),
    EMPTY_TOTALS,
  );
  return {
    range,
    bucket: range === "24h" ? "hour" : "day",
    bucketSeconds: range === "24h" ? 3600 : 86400,
    tzOffset: 0,
    from: 1_000_000,
    to: 1_007_200,
    nowUnix: 1_007_000,
    buckets: [1_000_000, 1_003_600],
    totals: sum,
    keys,
  } satisfies ApiKeyUsageResponse;
}

let served: ApiKeyUsageResponse;
let ranges: string[];

beforeEach(() => {
  ranges = [];
  served = usage([]);
  mockServer.use(
    http.get(apiUrl("/api-keys/usage"), ({ request }) => {
      ranges.push(new URL(request.url).searchParams.get("range") ?? "");
      return HttpResponse.json(served);
    }),
  );
});

async function card(): Promise<HTMLElement> {
  return screen.findByRole("region", { name: "Usage by key" });
}

/** The row names in list order (the open buttons carry "View usage for …"). */
async function rowNames(region: HTMLElement): Promise<string[]> {
  const list = await within(region).findByRole("list", { name: "API keys by usage" });
  return within(list)
    .getAllByRole("listitem")
    .map((item) => {
      const open = within(item).queryByRole("button");
      return open?.getAttribute("aria-label") ?? item.textContent ?? "";
    });
}

describe("KeyUsageCard", () => {
  it("shows the empty state when no key has traffic", async () => {
    renderWithProviders(<KeyUsageCard />);
    const region = await card();
    expect(await within(region).findByText("No usage in this range")).toBeInTheDocument();
    expect(within(region).queryByRole("list")).toBeNull();
    expect(within(region).getByText("Last 24 hours, from the request log")).toBeInTheDocument();
  });

  it("ranks keys by requests and switches to credits", async () => {
    served = usage([
      entry("a", "key", { requests: 12, failed: 2, credits: 0.5 }, { name: "alpha" }),
      entry("b", "key", { requests: 4, credits: 3.25 }, { name: "beta" }),
      entry("c", "key", { requests: 8, credits: 1 }, { name: "gamma" }),
    ]);
    const { user } = renderWithProviders(<KeyUsageCard />);
    const region = await card();

    expect(await rowNames(region)).toEqual([
      "View usage for alpha",
      "View usage for gamma",
      "View usage for beta",
    ]);
    expect(within(region).getByText("24 requests")).toBeInTheDocument();
    expect(within(region).getByText("2 failed")).toBeInTheDocument();

    await user.click(within(region).getByRole("radio", { name: "Credits" }));
    expect(await rowNames(region)).toEqual([
      "View usage for beta",
      "View usage for gamma",
      "View usage for alpha",
    ]);
    expect(within(region).getByText("4.75 credits")).toBeInTheDocument();
    expect(within(region).getByText("3.25")).toBeInTheDocument();
    expect(within(region).getByText("12 requests")).toBeInTheDocument();
  });

  it("folds keys after the top five into one row", async () => {
    served = usage(
      ["a", "b", "c", "d", "e", "f", "g"].map((id, index) =>
        entry(id, "key", { requests: 10 - index }, { name: `key-${id}` }),
      ),
    );
    renderWithProviders(<KeyUsageCard />);
    const names = await rowNames(await card());
    expect(names).toHaveLength(6);
    expect(names[4]).toBe("View usage for key-e");
    expect(names[5]).toContain("2 other keys");
  });

  it("labels no-key, invalid and deleted rows", async () => {
    served = usage([
      entry("none", "none", { requests: 9 }),
      entry("invalid", "invalid", { requests: 3, failed: 3 }),
      entry("gone", "deleted", { requests: 2 }, { keyMasked: "sk-del****1234" }),
      entry("u", "key", { requests: 1 }, { keyMasked: "sk-unn****5678" }),
    ]);
    renderWithProviders(<KeyUsageCard />);
    const region = await card();
    expect(await rowNames(region)).toEqual([
      "View usage for No API key",
      "View usage for Invalid keys",
      "View usage for Deleted key",
      // An unnamed key goes by its masked value.
      "View usage for sk-unn****5678",
    ]);
    // Two deleted keys differ only in their masked values: the name is cut, never the key.
    const deletedKey = within(region).getByText("sk-del****1234");
    expect(deletedKey).toHaveClass("shrink-0");
    expect(deletedKey).not.toHaveClass("truncate");
    expect(within(region).getByText("3 failed")).toBeInTheDocument();
    expect(within(region).queryByText(/Turn on Require an API key/)).toBeNull();
  });

  it("explains keyless traffic when no request carried a key", async () => {
    served = usage([entry("none", "none", { requests: 5 })]);
    renderWithProviders(<KeyUsageCard />);
    const region = await card();
    expect(await within(region).findByText(/Turn on Require an API key/)).toBeInTheDocument();
  });

  it("points at clients without a key when keys are already required", async () => {
    mockDb.settings.requireApiKey = true;
    served = usage([entry("none", "none", { requests: 5, failed: 5 })]);
    renderWithProviders(<KeyUsageCard />);
    const region = await card();
    expect(
      await within(region).findByText(/were rejected because Require an API key is on/),
    ).toBeInTheDocument();
    expect(within(region).queryByText(/Turn on Require an API key/)).toBeNull();
  });

  it("masks emails in key names in privacy mode", async () => {
    served = usage([entry("a", "key", { requests: 1 }, { name: "ci bob@example.com" })]);
    renderWithProviders(<KeyUsageCard />, { privacy: true });
    const region = await card();
    expect(await rowNames(region)).toEqual(["View usage for ci bo***@ex***.com"]);
    expect(region.textContent).not.toContain("bob@example.com");
  });

  it("shows email key names in full with privacy off", async () => {
    served = usage([entry("a", "key", { requests: 1 }, { name: "ci bob@example.com" })]);
    renderWithProviders(<KeyUsageCard />, { privacy: false });
    expect(await rowNames(await card())).toEqual(["View usage for ci bob@example.com"]);
  });

  it("refetches with range=7d", async () => {
    served = usage([entry("a", "key", { requests: 1 }, { name: "alpha" })]);
    const { user } = renderWithProviders(<KeyUsageCard />);
    const region = await card();
    await rowNames(region);
    expect(ranges).toEqual(["24h"]);

    served = usage([entry("a", "key", { requests: 40 }, { name: "alpha" })], "7d");
    await user.click(within(region).getByRole("radio", { name: "7d" }));
    await waitFor(() => expect(ranges).toEqual(["24h", "7d"]));
    expect(await within(region).findByText("40 requests")).toBeInTheDocument();
    expect(within(region).getByText("Last 7 days, from the request log")).toBeInTheDocument();
  });

  it("shows a retry when the usage fails to load", async () => {
    mockServer.use(
      http.get(apiUrl("/api-keys/usage"), () =>
        HttpResponse.json({ error: "database is locked" }, { status: 500 }),
      ),
    );
    renderWithProviders(<KeyUsageCard />);
    const region = await card();
    const alert = await within(region).findByRole("alert");
    expect(within(alert).getByText("Could not load key usage")).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("opens the key's usage sheet from its row", async () => {
    served = usage([
      entry("a", "key", { requests: 3, failed: 1 }, { name: "alpha", keyMasked: "sk-alp****0001" }),
    ]);
    const { user } = renderWithProviders(<KeyUsageCard />);
    const region = await card();
    await user.click(await within(region).findByRole("button", { name: "View usage for alpha" }));
    const sheet = await screen.findByRole("dialog", { name: "alpha" });
    expect(within(sheet).getByText("sk-alp****0001")).toBeInTheDocument();
    expect(ranges).toEqual(["24h"]);
  });
});
