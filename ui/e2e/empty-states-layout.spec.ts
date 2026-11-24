/// <reference lib="dom" />
import { expect, type Page, test } from "@playwright/test";

/**
 * Empty states centre in their card's body (mock mode, the empty dataset). Cards in a row
 * stretch to the tallest one, so a card with nothing to show is often taller than its notice:
 * the notice sits midway between the header and the bottom edge, not under the header.
 */

const PASSWORD = "12345678";
/** How far, in px, the space above a notice may differ from the space below it. */
const TOLERANCE = 8;

async function signIn(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  // The remote version check is the app's only external call; keep it off the network.
  await page.route("https://raw.githubusercontent.com/**", (route) => route.abort());
  await page.goto("/?mock=empty");
  await page.waitForURL(/\/(setup|login)/);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.evaluate(() => document.fonts.ready);
}

/** The space above and below the empty notice inside the body of the card titled `title`. */
async function noticeGaps(page: Page, title: string): Promise<{ above: number; below: number }> {
  const card = page
    .getByRole("heading", { name: title, exact: true })
    .locator("xpath=ancestor::section[1]");
  await expect(card.locator('[data-slot="empty"]')).toBeVisible();
  return card.evaluate((section) => {
    const kids = [...section.children].filter((kid) => kid.getBoundingClientRect().height > 0);
    const notice = section.querySelector('[data-slot="empty"]') as HTMLElement;
    const holder = kids.findIndex((kid) => kid.contains(notice));
    let top = section.getBoundingClientRect().top;
    let bottom = section.getBoundingClientRect().bottom;
    for (const kid of kids.slice(0, holder))
      top = Math.max(top, kid.getBoundingClientRect().bottom);
    for (const kid of kids.slice(holder + 1)) {
      bottom = Math.min(bottom, kid.getBoundingClientRect().top);
    }
    const parts = notice.querySelectorAll(
      ':scope > [data-slot="empty-header"], :scope > [data-slot="empty-content"]',
    );
    const rects = [...parts].map((part) => part.getBoundingClientRect());
    return {
      above: Math.min(...rects.map((rect) => rect.top)) - top,
      below: bottom - Math.max(...rects.map((rect) => rect.bottom)),
    };
  });
}

function expectCentred(gaps: { above: number; below: number }): void {
  expect(Math.abs(gaps.above - gaps.below)).toBeLessThanOrEqual(TOLERANCE);
}

test("Overview notices centre in cards a taller neighbour stretches", async ({ page }) => {
  await signIn(page);
  // Needs attention stretches to the traffic chart's height.
  expectCentred(await noticeGaps(page, "Needs attention"));
  expectCentred(await noticeGaps(page, "Traffic"));

  // Model mix with data is taller than Traffic by account with none: the row stretches it.
  await page.locator("#overview-model-mix").evaluate((card) => {
    (card as HTMLElement).style.minHeight = "560px";
  });
  const gaps = await noticeGaps(page, "Traffic by account");
  expect(gaps.above).toBeGreaterThan(150);
  expectCentred(gaps);
});

test("the key holder's usage notices centre beside the taller chart", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("https://raw.githubusercontent.com/**", (route) => route.abort());
  await page.goto("/user/login?mock=empty");
  await page.locator('input[name="apiKey"]').fill("sk-demo-new");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname.replace(/\/$/, "") === "/user");
  await page.evaluate(() => document.fonts.ready);
  expectCentred(await noticeGaps(page, "Usage by model"));
  expectCentred(await noticeGaps(page, "Requests"));
});
