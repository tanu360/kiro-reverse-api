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
    const input = page.getByRole("combobox", { name: "Search" });
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
    // The header's theme control opens the modes as a radio menu (ThemeSwitch variant="menu").
    const toggle = page.getByRole("button", { name: /^Theme:/ });
    async function pick(mode: "Light" | "Dark" | "System"): Promise<void> {
      await toggle.click();
      const item = page.getByRole("menuitemradio", { name: mode });
      await item.click();
      await expect(item).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
      await expect(item).toBeHidden();
    }
    // The OS scheme here is light.
    await expect(html).not.toHaveClass(dark);
    await pick("Light");
    await expect(toggle).toHaveAttribute("data-theme-mode", "light");
    await expect(html).not.toHaveClass(dark);
    await pick("Dark");
    await expect(toggle).toHaveAttribute("data-theme-mode", "dark");
    await expect(html).toHaveClass(dark);
    await pick("System");
    await expect(toggle).toHaveAttribute("data-theme-mode", "system");
    await expect(html).not.toHaveClass(dark);
  });

  test("sidebar is a sheet below 1024 px and persistent from 1024 px", async ({ page }) => {
    const sheet = page.locator('[data-slot="sidebar"][data-mobile="true"]');
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(nav).toBeHidden();
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(nav).toBeVisible();
    await expect(sheet).toHaveCount(0);
  });

  test("one Escape closes the sheet after its Admin menu was used", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const sheet = page.locator('[data-slot="sidebar"][data-mobile="true"]');
    const trigger = page.getByRole("button", { name: "Toggle sidebar" });
    await trigger.click();
    await expect(sheet).toBeVisible();
    await page.getByRole("button", { name: "Admin menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Admin menu" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test.describe("on a touch screen", () => {
    // Phone header icons are 36 px under a fine pointer; a coarse pointer (touch emulation)
    // grows every control to at least 40 px.
    test.use({ hasTouch: true });

    test("phone touch targets in the sheet and the command menu are at least 40 px", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const search = page.getByRole("button", { name: "Search" });
      const searchBox = await search.boundingBox();
      expect(searchBox?.width).toBeGreaterThanOrEqual(40);
      expect(searchBox?.height).toBeGreaterThanOrEqual(40);

      await page.getByRole("button", { name: "Toggle sidebar" }).click();
      const sheet = page.locator('[data-slot="sidebar"][data-mobile="true"]');
      await expect(sheet).toBeVisible();
      const targets = sheet.locator("a, button");
      const count = await targets.count();
      expect(count).toBeGreaterThan(8);
      for (let i = 0; i < count; i++) {
        const box = await targets.nth(i).boundingBox();
        if (!box) continue;
        expect(box.height, (await targets.nth(i).textContent()) ?? "").toBeGreaterThanOrEqual(40);
      }
      await page.keyboard.press("Escape");

      await search.click();
      const option = page.getByRole("option").first();
      await expect(option).toBeVisible();
      // The dialog zooms in; measure once it settles.
      await expect
        .poll(async () => (await option.boundingBox())?.height ?? 0)
        .toBeGreaterThanOrEqual(40);
    });
  });

  test("an unknown search value does not break the page", async ({ page }) => {
    await page.goto("/admin/?range=7d");
    await expect(page.locator("main#main h1")).toHaveText("Overview");
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await page.goto("/admin/requests?page=-3&pageSize=7&sort=bogus&status=x");
    await expect(page.locator("main#main h1")).toHaveText("Requests");
  });

  test("the tab title names the page", async ({ page }) => {
    await expect(page).toHaveTitle("Overview · Kiro Proxy");
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Settings", exact: true })
      .click();
    await expect(page).toHaveTitle("Settings · Kiro Proxy");
  });

  test("sign-out dismisses the session's toasts", async ({ page }) => {
    // The first-run sign-in shows "Change the generated password" for 10 s.
    const hint = page.getByText("Change the generated password in Settings.");
    await expect(hint).toBeVisible();
    await page.getByRole("button", { name: "Admin menu" }).first().click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/admin\/(login|setup)/);
    await expect(hint).toBeHidden();
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
