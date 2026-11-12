/// <reference lib="dom" />
import { expect, type Page, test } from "@playwright/test";

/**
 * Pseudo-locale check (mock mode). The dev/test-only "pseudo" language wraps every translated
 * string in ⟦…⟧. On every route and in the main dialogs, menus and sheets, every visible text
 * node and every aria-label/title/placeholder must sit inside markers, except data: what the
 * (mock) server sent, numbers, dates and times from Intl, emails, model ids, keys, URLs and the
 * product tokens below. Anything else is a string that bypassed the locale files.
 */

const PASSWORD = "12345678";
const OPEN = "⟦";
const CLOSE = "⟧";

// Words Intl writes into en-US dates, times, relative times and units (the pseudo language
// formats like English), plus brand and product tokens that stay as written in every language.
const ALLOWED_WORDS = new Set(
  [
    "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec",
    "Mon Tue Wed Thu Fri Sat Sun AM PM",
    "ago in yesterday today tomorrow now last next this",
    "second seconds minute minutes hour hours day days week weeks month months year years",
    "sec min hr ms s m h d B kB MB GB K M T byte bytes",
    "Kiro Proxy AWS Builder ID IAM Identity Center Microsoft Entra Claude Code Codex OpenAI",
    "Anthropic JSON URL HTTP GET POST PUT PATCH DELETE Ctrl Shift Alt Enter Esc Tab",
    // Language names, shown in their own script.
    "English 中文 Tiếng Việt Português Brasil",
  ]
    .join(" ")
    .split(/\s+/),
);

// Data shapes: masked or plain emails, ids and slugs (model ids, key names, account labels in
// kebab case), API keys, URLs and paths, versions, hex ids.
const DATA_PATTERNS: RegExp[] = [
  /^[\w.*+-]+@[\w.*-]+$/,
  /^[A-Za-z][\w]*(?:[-_.:][\w*]+)+…?$/,
  /^(?:sk|ksk)[-_][\w*]+$/,
  /^(?:https?:\/\/|\/)\S*$/,
  /^v\d+(?:\.\d+)*$/,
  /^[\da-f]+(?:-[\da-f]+)*…?$/i,
  // Compact numbers and units from Intl: 9.9M, 30.8K, 56.4kB, 1.84s, 120ms.
  /^[\d.,]+(?:K|M|B|T|kB|MB|GB|ms|s|m|h|d)$/,
  // A lone letter: an avatar's initial, cut from the email beside it.
  /^\p{L}$/u,
];

const WORD_SEPARATORS = /[\s,;·|()[\]{}"'“”«»:]+/;

interface Leak {
  where: string;
  text: string;
}

/** Collects visible text and user-visible attributes that are not inside pseudo markers. */
function collectLeaks(markers: { open: string; close: string }): Leak[] {
  const { open, close } = markers;
  const leaks: Leak[] = [];
  const visible = (el: Element | null): boolean =>
    Boolean(el?.checkVisibility({ visibilityProperty: true }));
  const describeElement = (el: Element) =>
    `<${el.tagName.toLowerCase()}${el.getAttribute("data-slot") ? ` data-slot=${el.getAttribute("data-slot")}` : ""}>`;

  // Text nodes in document order; a translated string can span several nodes (rich text), so
  // the marker depth carries across nodes.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let depth = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(parent.tagName)) continue;
    // Code snippets, key names and wire field names are code, not prose; so is a copy field's
    // value, which a multiline field splits into one text node per URL segment.
    if (parent.closest("code, pre, kbd, samp, [data-slot=copy-field] [role=textbox]")) continue;
    // Base UI's Meter and Progress add a visually hidden role="presentation" "x" as a VoiceOver
    // workaround; it is never read or shown.
    if (parent.getAttribute("role") === "presentation" && parent.style.clipPath) continue;
    let outside = "";
    for (const ch of node.nodeValue ?? "") {
      if (ch === open) {
        depth += 1;
        outside += "\n";
      } else if (ch === close) {
        depth = Math.max(0, depth - 1);
        outside += "\n";
      } else if (depth === 0) outside += ch;
    }
    if (/\p{L}/u.test(outside) && visible(parent)) {
      leaks.push({ where: `text ${describeElement(parent)}`, text: outside });
    }
  }

  const attributes = [
    "aria-label",
    "aria-description",
    "aria-roledescription",
    "title",
    "placeholder",
    "alt",
    "aria-valuetext",
  ];
  for (const el of document.body.querySelectorAll(attributes.map((a) => `[${a}]`).join(","))) {
    if (!visible(el)) continue;
    for (const name of attributes) {
      const value = el.getAttribute(name);
      if (!value) continue;
      let level = 0;
      let outside = "";
      for (const ch of value) {
        if (ch === open) {
          level += 1;
          outside += "\n";
        } else if (ch === close) {
          level = Math.max(0, level - 1);
          outside += "\n";
        } else if (level === 0) outside += ch;
      }
      if (/\p{L}/u.test(outside))
        leaks.push({ where: `${name} ${describeElement(el)}`, text: outside });
    }
  }

  if (!document.title.startsWith(open))
    leaks.push({ where: "document.title", text: document.title });
  return leaks;
}

/** Strings the mock server sent; they are data and may appear untranslated. */
function collectServerStrings(page: Page): Set<string> {
  const strings = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (value.trim()) strings.add(value.trim());
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  page.on("response", async (response) => {
    if (!response.url().includes("/admin/api/")) return;
    if (!(response.headers()["content-type"] ?? "").includes("json")) return;
    try {
      visit(await response.json());
    } catch {
      // Not JSON after all, or the body is gone.
    }
  });
  return strings;
}

function isData(fragment: string, serverStrings: Set<string>): boolean {
  const text = fragment.trim();
  if (!/\p{L}/u.test(text) || serverStrings.has(text)) return true;
  // Word by word: Intl words, data shapes, or words of what the server sent (upstream error
  // sentences, nicknames, backup notes), so masked emails inside server text still count.
  const serverWords = new Set([...serverStrings].flatMap((value) => value.split(WORD_SEPARATORS)));
  const isDataToken = (token: string) => {
    const bare = token.replace(/^["'(]+|[)"',;.!?…]+$/g, "");
    return DATA_PATTERNS.some((pattern) => pattern.test(bare));
  };
  // URLs and other data tokens first (they contain ":" and "/"), then word by word.
  return text.split(/\s+/).every(
    (token) =>
      isDataToken(token) ||
      token
        .split(WORD_SEPARATORS)
        .filter((word) => /\p{L}/u.test(word))
        .every(
          (word) =>
            ALLOWED_WORDS.has(word.replace(/[.!?…]+$/, "")) ||
            isDataToken(word) ||
            serverWords.has(word),
        ),
  );
}

/** Every string in the page's mock database (MSW runs in the page in mock mode). */
async function mockDbStrings(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const strings: string[] = [];
    const seen = new Set<unknown>();
    const visit = (value: unknown) => {
      if (typeof value === "string") strings.push(value.trim());
      else if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value);
        Object.values(value).forEach(visit);
      }
    };
    try {
      const path = "/src/lib/mocks/db.ts";
      visit((await import(/* @vite-ignore */ path)).mockDb);
    } catch {
      // Not mock mode: only the responses count as data.
    }
    return strings.filter(Boolean);
  });
}

async function expectAllTranslated(page: Page, serverStrings: Set<string>, label: string) {
  // Charts and lists render after their queries settle. Live polling can keep the network
  // busy, so networkidle is a bounded wait.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  for (const value of await mockDbStrings(page)) serverStrings.add(value);
  const leaks = await page.evaluate(collectLeaks, { open: OPEN, close: CLOSE });
  const fragments = leaks.flatMap((leak) =>
    leak.text
      .split("\n")
      .map((part) => part.trim())
      .filter((part) => /\p{L}/u.test(part) && !isData(part, serverStrings))
      .map((part) => `${label}: ${leak.where} ${JSON.stringify(part)}`),
  );
  expect([...new Set(fragments)], `untranslated text on ${label}`).toEqual([]);
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForURL(/\/(setup|login)/);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/^https?:\/\/[^/]+\/?$/);
  await expect(page.getByRole("button", { name: /Search/ })).toBeVisible();
}

test.describe("pseudo locale", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  // Nine pages or seven overlays, each checked after its data loads.
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      try {
        localStorage.setItem("kiro_lang", "pseudo");
      } catch {
        // Storage blocked: the test then fails on the first page, which is the right signal.
      }
    });
    // The remote version check is the app's only external call; keep it off the network.
    await page.route("https://raw.githubusercontent.com/**", (route) => route.abort());
  });

  test("every route renders only translated text", async ({ page }) => {
    const serverStrings = collectServerStrings(page);
    await page.goto("/");
    await page.waitForURL(/\/setup/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expectAllTranslated(page, serverStrings, "setup");

    await signIn(page);
    for (const route of [
      "",
      "accounts",
      "requests",
      "api",
      "settings",
      "backups",
      "no-such-page",
    ]) {
      await page.goto(`/${route}`);
      await expect(page.locator("main#main")).toBeVisible();
      await expectAllTranslated(page, serverStrings, `/${route}`);
    }

    // Sign out through the Admin menu, then check the login page.
    await page.goto("/");
    await page.getByRole("button", { name: /Admin/ }).first().click();
    await page.getByRole("menuitem", { name: /Sign out/ }).click();
    await page.waitForURL(/\/login/);
    await expectAllTranslated(page, serverStrings, "login");
  });

  test("dialogs, menus and sheets render only translated text", async ({ page }) => {
    const serverStrings = collectServerStrings(page);
    await signIn(page);

    // Command menu.
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("combobox", { name: /Search/ })).toBeVisible();
    await expectAllTranslated(page, serverStrings, "command menu");
    await page.keyboard.press("Escape");

    // Language menu.
    await page.getByRole("button", { name: /Language/ }).click();
    await expect(page.getByRole("menuitemradio").first()).toBeVisible();
    await expectAllTranslated(page, serverStrings, "language menu");
    await page.keyboard.press("Escape");

    // Accounts: add-account dialog, row menu, account detail sheet, confirm dialog.
    await page.goto("/accounts");
    await page
      .getByRole("button", { name: /Add account/ })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectAllTranslated(page, serverStrings, "add-account dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    const rowMenu = page
      .getByRole("main")
      .getByRole("button", { name: /More actions/ })
      .first();
    await rowMenu.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expectAllTranslated(page, serverStrings, "account row menu");
    await page.getByRole("menuitem", { name: /Delete/ }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expectAllTranslated(page, serverStrings, "confirm dialog");
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /Cancel/ })
      .click();
    await expect(page.getByRole("alertdialog")).toBeHidden();

    // Details sits in the row's More actions menu.
    await rowMenu.click();
    await page.getByRole("menuitem", { name: /Details/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectAllTranslated(page, serverStrings, "account detail sheet");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    // Requests: request detail sheet.
    await page.goto("/requests");
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    // Enter on a focused row opens it (a click may land on a cell's own control).
    await page.locator('main#main tbody tr[tabindex="0"]').first().press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectAllTranslated(page, serverStrings, "request detail sheet");
    await page.keyboard.press("Escape");
  });
});
