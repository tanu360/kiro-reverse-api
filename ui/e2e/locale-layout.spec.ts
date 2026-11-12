/// <reference lib="dom" />
import { expect, type Page, test } from "@playwright/test";

/**
 * Locale layout checks (mock mode) for the languages whose words run longest: the pre-paint
 * <html lang>, and an accounts table that fits a 1440 px window without scrolling sideways.
 */

const PASSWORD = "12345678";

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForURL(/\/(setup|login)/);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/^https?:\/\/[^/]+\/?$/);
  await expect(page.locator("main#main")).toBeVisible();
}

for (const lang of ["vi", "pt-BR"]) {
  test.describe(`${lang} layout`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript((stored) => {
        try {
          localStorage.setItem("kiro_lang", stored);
        } catch {
          // Storage blocked: the lang assertions then fail, which is the right signal.
        }
      }, lang);
      // The remote version check is the app's only external call; keep it off the network.
      await page.route("https://raw.githubusercontent.com/**", (route) => route.abort());
    });

    test("the boot script sets <html lang> before the app loads", async ({ page }) => {
      // Without the app bundle, only the inline script in index.html can set the language.
      await page.route("**/src/main.tsx", (route) => route.abort());
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
    });

    test("the accounts table fits 1440 px without sideways scroll", async ({ page }) => {
      await signIn(page);
      await page.goto("/accounts");
      const container = page.locator('[data-slot="table-container"]');
      // Loaded rows, not the aria-hidden skeleton rows, which never overflow.
      await expect(container.locator("tbody tr:not([aria-hidden])").first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const { scrollWidth, clientWidth } = await container.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    });
  });
}
