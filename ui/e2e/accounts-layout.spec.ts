/// <reference lib="dom" />
import { expect, type Page, test } from "@playwright/test";

/**
 * Accounts list layout with the sidebar open (mock mode): the table from an `md`-wide list up,
 * with low-priority columns only from a 1,100 px list, and cards below `md`.
 */

const PASSWORD = "12345678";
const LOW_PRIORITY = ["Requests", "Tokens", "Credits", "Token expiry"];
const ALWAYS = ["Account", "Status", "Plan credits", "Enabled"];

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
  await expect(page.getByRole("list", { name: "Accounts" })).toHaveCount(0);
  const container = page.locator('[data-slot="table-container"]');
  const { scrollWidth, clientWidth } = await container.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  // One pixel of sub-pixel rounding at the 768 px edge.
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  // The row actions are on screen, not past the right edge.
  const actions = table.locator("tbody tr:not([aria-hidden])").first().locator("td").last();
  const box = await actions.boundingBox();
  expect(box && box.x + box.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  return table;
}

for (const width of [1280, 1366]) {
  test(`a ${width} px window with the sidebar open shows the table, not cards`, async ({
    page,
  }) => {
    await openAccounts(page, width);
    // The sidebar is open: it is a rail, not a sheet, from 1024 px.
    await expect(page.locator('[data-slot="sidebar"][data-state="expanded"]')).toBeVisible();
    const table = await expectTable(page);
    for (const name of ALWAYS) {
      await expect(table.getByRole("columnheader", { name, exact: true })).toBeVisible();
    }
    for (const name of LOW_PRIORITY) {
      await expect(table.getByRole("columnheader", { name, exact: true })).toBeHidden();
    }
  });
}

test("a 768 px list (1088 px window) still shows the table", async ({ page }) => {
  await openAccounts(page, 1088);
  await expectTable(page);
});

test("a list narrower than md (1024 px window, sidebar open) shows cards", async ({ page }) => {
  await openAccounts(page, 1024);
  await expect(page.getByRole("list", { name: "Accounts" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Accounts" })).toHaveCount(0);
});

test("a 1,100 px list shows every column", async ({ page }) => {
  await openAccounts(page, 1600);
  const table = await expectTable(page);
  for (const name of [...ALWAYS, ...LOW_PRIORITY]) {
    await expect(table.getByRole("columnheader", { name, exact: true })).toBeVisible();
  }
});
