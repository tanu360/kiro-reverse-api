/// <reference lib="dom" />
import { expect, test } from "@playwright/test";

test("mock sign-in survives reloads and new tabs, and re-login returns to Accounts", async ({
  page,
  context,
}) => {
  await page.route("https://raw.githubusercontent.com/**", (route) => route.abort());
  await page.goto("/admin/accounts?plan=pro");
  await expect(page).toHaveURL(/\/setup\?redirect=/);
  await expect(page.getByRole("checkbox", { name: "Stay signed in" })).toBeChecked();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/accounts\?plan=pro$/);
  await expect(page.getByRole("table", { name: "Accounts" })).toBeVisible();
  // APIRequestContext bypasses the service worker, like a request during worker teardown.
  // It must get a mock diagnostic, never the real backend's authentication rejection.
  const fallback = await page.request.get("/admin/api/status", {
    headers: { "X-Admin-Token": "mock-probe" },
  });
  expect(fallback.status()).toBe(503);
  expect((await fallback.json()).error).toContain("Mock worker");
  await page.reload();
  await expect(page.getByRole("table", { name: "Accounts" })).toBeVisible();
  await expect(page).toHaveURL(/\/accounts\?plan=pro$/);

  const other = await context.newPage();
  await other.goto("/admin/accounts");
  await expect(other.getByRole("table", { name: "Accounts" })).toBeVisible();
  await other.close();

  // An actually invalid server token must still require sign-in, preserving the requested page.
  await page.evaluate(() => localStorage.setItem("kiro_admin_token", "invalid-token"));
  await page.reload();
  await expect(page).toHaveURL(/\/login\?redirect=/);
  expect(new URL(page.url()).searchParams.get("redirect")).toBe("/accounts?plan=pro");
  await page.locator('input[type="password"]').fill("12345678");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/accounts\?plan=pro$/);
  await expect(page.getByRole("table", { name: "Accounts" })).toBeVisible();
});
