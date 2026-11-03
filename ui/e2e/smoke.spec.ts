import { expect, test } from "@playwright/test";

test("serves the admin app shell", async ({ page }) => {
  const response = await page.goto("/admin/");
  expect(response?.status()).toBe(200);
  await expect(page.locator("#root")).toBeAttached();
});
