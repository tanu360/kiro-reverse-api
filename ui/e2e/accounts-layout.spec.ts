/// <reference lib="dom" />
import { expect, type Page, test } from "@playwright/test";

/**
 * Accounts list layout (mock mode). DataTable switches on its own container width, not the
 * window's: divided cards below a 42rem (672 px) list, the table from there up. The table's
 * lower-priority columns join as the list widens: Requests from 56rem (896 px), Last used from
 * 64rem (1,024 px) and Token expiry from 72rem (1,152 px). With the sidebar open (a rail from a
 * 1,024 px window) the list is about 280 px narrower than the window; below 1,024 px the sidebar
 * is a sheet and the list takes the window less the page gutters.
 */

const PASSWORD = "12345678";
const ALWAYS = ["Account", "Status", "Usage", "Enabled"];
const REQUESTS = "Requests";
const LAST_USED = "Last used";
const EXPIRY = "Token expiry";

async function openAccounts(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  // The remote version check is the app's only external call; keep it off the network.
  await page.route("https://raw.githubusercontent.com/**", (route) => route.abort());
  await page.goto("/admin/");
  await page.waitForURL(/\/admin\/(setup|login)/);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/admin\/?$/);
  await page.goto("/admin/accounts");
  await expect(page.locator("main#main h1")).toHaveText("Accounts");
  await page.evaluate(() => document.fonts.ready);
}

/** Expects the table, with loaded rows, that does not scroll sideways. */
async function expectTable(page: Page) {
  const table = page.getByRole("table", { name: "Accounts" });
  await expect(table.locator("tbody tr:not([aria-hidden])").first()).toBeVisible();
  // The cards are rendered too, hidden by the container query.
  await expect(page.getByRole("list", { name: "Accounts" })).toHaveCount(0);
  const container = page.locator('[data-slot="table-container"]');
  const { scrollWidth, clientWidth } = await container.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  // One pixel of sub-pixel rounding.
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  // The row actions are on screen, not past the right edge.
  const actions = table.locator("tbody tr:not([aria-hidden])").first().locator("td").last();
  const box = await actions.boundingBox();
  expect(box && box.x + box.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  return table;
}

async function expectColumns(page: Page, shown: string[], hidden: string[]): Promise<void> {
  const table = await expectTable(page);
  for (const name of [...ALWAYS, ...shown]) {
    await expect(table.getByRole("columnheader", { name, exact: true })).toBeVisible();
  }
  for (const name of hidden) {
    await expect(table.getByRole("columnheader", { name, exact: true })).toBeHidden();
  }
}

const SIDEBAR_OPEN = [
  // ~740 px list: the table, with the four columns that always show.
  { width: 1024, shown: [], hidden: [REQUESTS, LAST_USED, EXPIRY] },
  // ~1,000 px list: Requests joins.
  { width: 1280, shown: [REQUESTS], hidden: [LAST_USED, EXPIRY] },
  // ~1,080 px list: Last used joins.
  { width: 1366, shown: [REQUESTS, LAST_USED], hidden: [EXPIRY] },
  // ~1,320 px list: every column.
  { width: 1600, shown: [REQUESTS, LAST_USED, EXPIRY], hidden: [] },
];

for (const { width, shown, hidden } of SIDEBAR_OPEN) {
  test(`a ${width} px window with the sidebar open shows the table and its columns`, async ({
    page,
  }) => {
    await openAccounts(page, width);
    // The sidebar is open: it is a rail, not a sheet, from 1024 px.
    await expect(page.locator('[data-slot="sidebar"][data-state="expanded"]')).toBeVisible();
    await expectColumns(page, shown, hidden);
  });
}

test("a tablet-portrait window (760 px, ~726 px list) still shows the table", async ({ page }) => {
  await openAccounts(page, 760);
  await expectColumns(page, [], [REQUESTS, LAST_USED, EXPIRY]);
});

test("a list narrower than 42rem (640 px window) shows cards", async ({ page }) => {
  await openAccounts(page, 640);
  await expect(page.getByRole("list", { name: "Accounts" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Accounts" })).toHaveCount(0);
});
