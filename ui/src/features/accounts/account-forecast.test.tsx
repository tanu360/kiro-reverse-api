import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AccountForecast } from "@/lib/api/types";
import type { TFunction } from "@/lib/i18n";
import { mockDb } from "@/lib/mocks/db";
import { renderWithProviders } from "@/test/render";
import { ForecastLine, forecastHint, forecastSentence } from "./account-forecast";
import { accountForecast } from "./mocks";

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const DAY = 86_400;
const nowSec = NOW / 1000;

/** Echoes the key and its params, so the tests see what was asked for. */
const t: TFunction = (key, params) => `${key} ${JSON.stringify(params ?? {})}`;

function forecast(overrides: Partial<AccountForecast>): AccountForecast {
  return {
    status: "lasts",
    spent: 70,
    spanDays: 7,
    burnPerDay: 10,
    remaining: 300,
    resetAt: nowSec + 10 * DAY,
    leftAtReset: 200,
    ...overrides,
  };
}

describe("forecast copy", () => {
  it("hints only at an account that runs out before its reset", () => {
    const runsOut = forecast({ status: "runs_out", depletesAt: nowSec + 4 * DAY, leftAtReset: 0 });
    expect(forecastHint(runsOut, t, "en", NOW)).toBe('forecast.hint {"relative":"in 4 days"}');
    for (const status of ["lasts", "idle", "empty", "unknown"] as const) {
      expect(forecastHint(forecast({ status }), t, "en", NOW)).toBeNull();
    }
    expect(forecastHint(undefined, t, "en", NOW)).toBeNull();
  });

  it("says when the credits run out, or how many are left at the reset", () => {
    const runsOut = forecast({ status: "runs_out", depletesAt: nowSec + 4 * DAY, leftAtReset: 0 });
    expect(forecastSentence(runsOut, 7, t, "en", NOW)).toContain('"relative":"in 4 days"');
    expect(forecastSentence(forecast({}), 7, t, "en", NOW)).toBe(
      'forecast.lastsLeftOver {"rate":"10","left":"200"}',
    );
    // Less than one credit left over reads as lasting, not as "0 left".
    expect(forecastSentence(forecast({ leftAtReset: 0.4 }), 7, t, "en", NOW)).toBe(
      'forecast.lasts {"rate":"10"}',
    );
    expect(forecastSentence(forecast({ status: "idle" }), 7, t, "en", NOW)).toBe(
      'forecast.idle {"days":7}',
    );
    expect(forecastSentence(forecast({ status: "empty" }), 7, t, "en", NOW)).toBeNull();
    expect(forecastSentence(forecast({ status: "unknown" }), 7, t, "en", NOW)).toBeNull();
  });
});

describe("mock forecast", () => {
  it("follows the server's states", () => {
    const base = mockDb.accounts[0];
    if (!base) throw new Error("missing seeded account");
    const resetIn = (days: number) => ({ nextResetAt: nowSec + days * DAY });
    // 400 used over the 20 days since the last reset: 20 a day, 100 left, 10 days to go.
    const short = accountForecast(
      { ...base, usageCurrent: 400, usageLimit: 500, lastUsed: nowSec, ...resetIn(10) },
      nowSec,
    );
    expect(short.status).toBe("runs_out");
    expect(short.depletesAt).toBe(nowSec + 5 * DAY);
    const plenty = accountForecast(
      { ...base, usageCurrent: 40, usageLimit: 500, lastUsed: nowSec, ...resetIn(10) },
      nowSec,
    );
    expect(plenty.status).toBe("lasts");
    expect(accountForecast({ ...base, usageCurrent: 500, usageLimit: 500 }, nowSec).status).toBe(
      "empty",
    );
    expect(accountForecast({ ...base, usageLimit: 0 }, nowSec).status).toBe("unknown");
  });
});

describe("ForecastLine", () => {
  it("renders the account's forecast in the warning colour when it runs out", async () => {
    const account = mockDb.accounts[0];
    if (!account) throw new Error("missing seeded account");
    const now = Math.floor(Date.now() / 1000);
    Object.assign(account, {
      usageCurrent: 450,
      usageLimit: 500,
      lastUsed: now,
      nextResetAt: now + 10 * DAY,
    });
    renderWithProviders(<ForecastLine accountId={account.id} />);
    const line = await screen.findByText(/run out/);
    expect(line).toHaveTextContent(/before they reset/);
    expect(line.className).toContain("text-warning-foreground");
  });
});
