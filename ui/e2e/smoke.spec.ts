import { expect, test } from "@playwright/test";

test("serves the admin app shell", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.locator("#root")).toBeAttached();
});

// Mock mode (pnpm dev:mock): first-run is pending on every fresh load; playwright.config.ts pins
// the mock's otherwise random password to 12345678.
test("first visit goes to setup, signs in with the first-run password and stays signed in", async ({
  page,
}) => {
  // The remote version check is the app's only external call; keep it off the network.
  await page.route("https://raw.githubusercontent.com/**", (route) => route.abort());

  await page.goto("/");
  // The guard's ?redirect= rides along from /login to /setup.
  await expect(page).toHaveURL(/\/setup(?:\?|$)/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome to Kiro Proxy");
  await expect(page.getByText("12345678", { exact: true })).toBeVisible();
  // Setup fills the generated password in for the first sign-in.
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("12345678");

  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?$/);
  await expect(page.locator("main#main h1")).toHaveText("Overview");
  await expect(page.getByText("Change the generated password in Settings.")).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?$/);
  await expect(page.locator("main#main h1")).toHaveText("Overview");
});
