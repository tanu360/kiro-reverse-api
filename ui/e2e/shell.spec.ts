import { expect, type Page, test } from "@playwright/test";

// Mock mode (pnpm dev:mock). First-run is pending on every fresh load, so the first visit
// lands on /admin/setup, whose sign-in form accepts the mock admin password.
const PASSWORD = "12345678";

async function signIn(page: Page): Promise<void> {
  await page.goto("/admin/");
  await page.waitForURL(/\/admin\/(setup|login)/);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/admin\/?$/);
  // The URL changes before the lazy shell mounts; wait for it so keyboard shortcuts are bound.
  await expect(page.getByRole("button", { name: "Search" })).toBeVisible();
}

test.describe("app shell", () => {
  test.beforeEach(async ({ page }) => {
    // The remote version check is the app's only external call; keep it off the network.
    await page.route("https://raw.githubusercontent.com/**", (route) => route.abort());
    await signIn(page);
  });

  test("lands on Overview", async ({ page }) => {
    await expect(page).toHaveURL(/\/admin\/?$/);
    await expect(page.locator('[data-slot="page-title"]')).toHaveText("Overview");
    await expect(page.locator("main#main h1")).toHaveText("Overview");
  });

  test("sidebar link navigates and the route survives a reload", async ({ page }) => {
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Accounts", exact: true })
      .click();
    await expect(page).toHaveURL(/\/admin\/accounts$/);
    await page.reload();
    await expect(page).toHaveURL(/\/admin\/accounts$/);
    await expect(page.locator("main#main h1")).toHaveText("Accounts");
  });

  test("Ctrl+K opens the command menu and Enter runs the match", async ({ page }) => {
    await page.keyboard.press("Control+k");
    const input = page.getByRole("combobox");
    await expect(input).toBeVisible();
    await input.fill("Backups");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/admin\/backups$/);
    await expect(input).toBeHidden();
  });

  test("theme switch toggles html.dark", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    const html = page.locator("html");
    const dark = /(^|\s)dark(\s|$)/;
    const toggle = page.getByRole("button", { name: /^Theme:/ });
    // The cycle is system, light, dark (old UI order); the OS scheme here is light.
    await expect(html).not.toHaveClass(dark);
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-theme-mode", "light");
    await expect(html).not.toHaveClass(dark);
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-theme-mode", "dark");
    await expect(html).toHaveClass(dark);
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-theme-mode", "system");
    await expect(html).not.toHaveClass(dark);
  });

  test("no horizontal page scroll at 390 px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator("main#main")).toBeVisible();
    // A string expression: the e2e tsconfig has no DOM lib.
    const scrollWidth = await page.evaluate<number>("document.documentElement.scrollWidth");
    expect(scrollWidth).toBeLessThanOrEqual(390);
  });
});
