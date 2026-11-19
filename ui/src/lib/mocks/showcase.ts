import { seedProxyPoolMock } from "@/features/proxy-pool/mocks";
import { mockDb, mockNowUnix } from "./db";

/*
 * The browser mock's showcase: on top of the full dataset it fills what a fresh install leaves
 * empty, so every screen has something to show. Only browser.ts calls it, for the full
 * dataset; the vitest suites never see these extras.
 */

/** The 4.1.0 notes from version.json, so the update dialog shows the real release. */
const RELEASE_NOTES =
  "📱 On a phone, the menu button at the top left shows an orange dot when a new version is out, so you see the update without opening the menu.";

const DAY = 86_400;

export function applyShowcase(): void {
  const now = mockNowUnix();

  // The server runs 4.0.9 and 4.1.0 is out: the update notice and dialog show the real notes.
  // The README screenshots run on 4.1.0 itself (sessionStorage kiro_mock_updated_version).
  mockDb.version = "4.0.9";
  mockDb.remoteVersion = { version: "4.1.0", changelog: RELEASE_NOTES };

  mockDb.responseHeaders = [
    { name: "X-Request-Id", value: "{request_id}", enabled: true },
    { name: "X-Kiro-Account", value: "{account_id}", enabled: true },
    { name: "X-Served-By", value: "kiro-proxy {model}", enabled: false },
  ];

  // An older sign-in of one account, so Accounts offers the duplicates review.
  const original = mockDb.accounts.find(
    (account) => account.authMethod.toLowerCase() === "idc" && account.email.trim() !== "",
  );
  if (original) {
    const id = `dup-${original.id.slice(4)}`;
    const copy = {
      ...original,
      id,
      nickname: original.nickname ? `${original.nickname} (old)` : "",
      lastRefresh: original.lastRefresh - 21 * DAY,
      expiresAt: original.expiresAt - 21 * DAY,
      enabled: false,
    };
    mockDb.accounts.push(copy);
    const secret = mockDb.secrets[original.id];
    if (secret) mockDb.secrets[id] = { ...secret, ...copy };
  }

  // A running pool: two healthy proxies, one that fails, one never checked.
  const ids = mockDb.accounts.filter((account) => account.enabled).map((account) => account.id);
  const assignments: Record<string, string> = {};
  ids.slice(0, 9).forEach((accountId, index) => {
    assignments[accountId] = index % 3 === 2 ? "p2" : "p1";
  });
  // The proxy pool's times are Unix milliseconds, as the server sends them; `now` is seconds.
  seedProxyPoolMock({
    mode: "on",
    directFallback: true,
    checkIntervalMin: 10,
    proxies: [
      {
        id: "p1",
        label: "Frankfurt residential",
        url: "socks5h://de1.proxy.northwind.studio:1080",
        username: "kiro",
        password: "showcase-secret",
        createdAt: (now - 12 * DAY) * 1000,
        health: { status: "ok", checkedAt: (now - 4 * 60) * 1000, latencyMs: 182 },
      },
      {
        id: "p2",
        label: "Virginia DC",
        url: "http://us-east.proxy.northwind.studio:3128",
        username: "",
        password: "",
        createdAt: (now - 9 * DAY) * 1000,
        health: { status: "ok", checkedAt: (now - 4 * 60) * 1000, latencyMs: 64 },
      },
      {
        id: "p3",
        label: "Singapore backup",
        url: "https://sg.proxy.northwind.studio:8443",
        username: "kiro",
        password: "showcase-secret",
        createdAt: (now - 3 * DAY) * 1000,
        health: {
          status: "failed",
          checkedAt: (now - 4 * 60) * 1000,
          failedAt: (now - 4 * 60) * 1000,
          lastError: "proxyconnect tcp: dial tcp: i/o timeout",
          errorCode: "timeout",
        },
      },
      {
        id: "p4",
        label: "",
        url: "socks5://10.0.0.24:1080",
        username: "",
        password: "",
        createdAt: (now - 20 * 60) * 1000,
        health: { status: "unknown" },
      },
    ],
    assignments,
  });
}
