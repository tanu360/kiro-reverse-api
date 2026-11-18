import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { resetProxyPoolMock, seedProxyPoolMock } from "./mocks";
import { ProxyPoolCard } from "./proxy-pool-card";

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

let recorded: Array<Promise<Recorded>> = [];

function onRequestStart({ request }: { request: Request }): void {
  const path = new URL(request.url).pathname.replace(/^\/admin\/api/, "");
  recorded.push(
    request
      .clone()
      .text()
      .then((text) => ({ method: request.method, path, body: text ? JSON.parse(text) : null })),
  );
}

/** Every pool write the card sent, in order. */
async function writes(): Promise<Recorded[]> {
  const all = await Promise.all(recorded);
  return all.filter((r) => r.method !== "GET");
}

const frankfurt = {
  id: "px_1",
  label: "Frankfurt",
  url: "socks5://10.0.0.1:1080",
  username: "bob",
  password: "s3cret-pool-pass",
  createdAt: 0,
  health: { status: "ok" as const, checkedAt: Date.now() - 60_000, latencyMs: 142 },
};

beforeEach(() => {
  // No global proxy, so no detected entry unless a test adds one.
  mockDb.proxy.proxyURL = "";
  resetProxyPoolMock();
  recorded = [];
  mockServer.events.on("request:start", onRequestStart);
});

afterEach(() => {
  mockServer.events.removeListener("request:start", onRequestStart);
});

/** Read out by the app's live region. */
async function expectAnnounced(text: string): Promise<void> {
  const line = await screen.findByText(text);
  expect(line.closest('[data-slot="live-announcer"]')).not.toBeNull();
}

/** The card's one-line failure notice. */
async function actionError(): Promise<HTMLElement> {
  const notice = await screen.findByRole("alert");
  expect(notice).toHaveAttribute("data-slot", "action-error");
  return notice;
}

async function renderCard() {
  const result = renderWithProviders(<ProxyPoolCard />);
  await screen.findByRole("switch", { name: "Use the proxy pool" });
  return result;
}

describe("ProxyPoolCard", () => {
  it("starts empty, with the pool switch off until a proxy is added", async () => {
    await renderCard();
    expect(screen.getByText(/No proxies yet/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Use the proxy pool" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.queryByRole("button", { name: "Check all" })).not.toBeInTheDocument();
  });

  it("lists a proxy with its status, latency and load, and never its password", async () => {
    seedProxyPoolMock({ proxies: [frankfurt], assignments: { a1: "px_1", a2: "px_1" } });
    const { container } = await renderCard();
    expect(await screen.findByText("Frankfurt")).toBeInTheDocument();
    expect(screen.getByText("socks5://10.0.0.1:1080")).toBeInTheDocument();
    expect(screen.getByText("Signs in as bob")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("2 accounts")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("s3cret-pool-pass");
  });

  it("adds a proxy with its credentials as their own fields", async () => {
    const { user } = await renderCard();
    await user.click(screen.getByRole("button", { name: "Add proxy" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Label/), "Home");
    await user.type(within(dialog).getByLabelText("Host"), "proxy.local");
    await user.type(within(dialog).getByLabelText("Port"), "1080");
    await user.type(within(dialog).getByLabelText("Username"), "alice");
    await user.type(within(dialog).getByLabelText("Password"), "pw");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    // Save reads Saved for a moment over the new row, then the dialog closes.
    expect(await within(dialog).findByRole("button", { name: "Saved" })).toBeInTheDocument();
    expect(await screen.findByText("Home")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await expectAnnounced("The proxy was added and is being checked.");
    expect(await writes()).toEqual([
      {
        method: "POST",
        path: "/proxy-pool/proxies",
        body: {
          label: "Home",
          url: "socks5://proxy.local:1080",
          username: "alice",
          password: "pw",
        },
      },
    ]);
    expect(screen.getByRole("switch", { name: "Use the proxy pool" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("keeps the saved password when an edit leaves the field empty", async () => {
    seedProxyPoolMock({ proxies: [frankfurt] });
    const { user } = await renderCard();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Password")).toHaveValue("");
    expect(within(dialog).getByText("Leave empty to keep the saved password.")).toBeInTheDocument();
    const label = within(dialog).getByLabelText(/^Label/);
    await user.clear(label);
    await user.type(label, "Berlin");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Berlin")).toBeInTheDocument();
    await expectAnnounced("The proxy was saved.");
    const [put] = await writes();
    expect(put.method).toBe("PUT");
    expect(put.path).toBe("/proxy-pool/proxies/px_1");
    expect(put.body).not.toHaveProperty("password");
  });

  it("checks every proxy and shows the failed one's error", async () => {
    const dead = {
      ...frankfurt,
      id: "px_2",
      label: "",
      url: "http://127.0.0.1:9",
      username: "",
      password: "",
    };
    seedProxyPoolMock({ proxies: [{ ...frankfurt, health: { status: "unknown" } }, dead] });
    const { user } = await renderCard();
    await user.click(await screen.findByRole("button", { name: "Check all" }));

    await expectAnnounced("Every proxy was checked.");
    // One failed check is a strike, not a verdict: the proxy stays in rotation, marked unhealthy.
    expect(await screen.findByText("Unhealthy")).toBeInTheDocument();
    expect(
      screen.getByText("Failed 1 time in a row. After 3, its accounts move.", { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Last error: The proxy refused the connection.", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/proxyconnect/)).not.toBeInTheDocument();
  });

  it("words a failed test from its code and keeps the server's text behind Details", async () => {
    const dead = { ...frankfurt, id: "px_2", label: "Dead", url: "http://127.0.0.1:9" };
    seedProxyPoolMock({ proxies: [dead] });
    const { user } = await renderCard();
    await user.click(await screen.findByRole("button", { name: "Test" }));

    // The row shows the result; a screen reader hears it.
    expect(await screen.findByText(/Last error: The proxy refused the connection\./)).toBeVisible();
    await expectAnnounced("Dead is not reachable. The proxy refused the connection.");
    // Details opens on a click or tap as well as on hover, and keyboard focus reaches it.
    const details = screen.getByRole("button", { name: "Details" });
    await user.click(details);
    const raw = await screen.findByText(/proxyconnect tcp: connect: connection refused/);
    expect(raw).toBeVisible();
    expect(details.tabIndex).toBe(0);
    // The note opens under Details, so the "Last error" sentence above stays readable.
    expect(raw.closest("[data-slot=popover-popup]")).toHaveAttribute("data-side", "bottom");
  });

  it.each([
    [{ errorCode: "tunnel", errorStatus: 502 }, "The proxy answered with HTTP 502."],
    [{ errorCode: "auth", errorStatus: 407 }, "The proxy rejected the username or password."],
    [
      { errorCode: "auth_required", errorStatus: 407 },
      "The proxy asks for a username and password.",
    ],
    [{ errorCode: "timeout" }, "Connection timed out."],
    [{ errorCode: "dns" }, "Could not resolve the proxy host."],
    [{ errorCode: "something_new" }, "The connection through the proxy failed."],
    [{}, "The connection through the proxy failed."],
  ])("words the last error %o", async (code, sentence) => {
    const health = { status: "failed" as const, lastError: "raw text: boom", ...code };
    seedProxyPoolMock({ proxies: [{ ...frankfurt, health }] });
    await renderCard();
    expect(
      await screen.findByText(`Last error: ${sentence}`, { exact: false }),
    ).toBeInTheDocument();
  });

  it("turns the pool on as the switch flips", async () => {
    seedProxyPoolMock({ proxies: [frankfurt] });
    const { user } = await renderCard();
    const toggle = screen.getByRole("switch", { name: "Use the proxy pool" });
    await user.click(toggle);

    await expectAnnounced("Your settings were saved.");
    await waitFor(() => expect(toggle).toBeChecked());
    expect(await writes()).toEqual([
      { method: "PUT", path: "/proxy-pool/settings", body: { mode: "on" } },
    ]);
  });

  it("removes a proxy after a confirm", async () => {
    seedProxyPoolMock({ proxies: [frankfurt] });
    const { user } = await renderCard();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));

    expect(await screen.findByText(/No proxies yet/)).toBeInTheDocument();
    await expectAnnounced("The proxy was removed.");
    // The row and its Remove are gone: focus is on Add proxy, not the page.
    await waitFor(() => expect(document.activeElement).toHaveAccessibleName("Add proxy"));
  });

  it("moves focus to the next row's Remove after a remove", async () => {
    const tokyo = { ...frankfurt, id: "px_2", label: "Tokyo", url: "http://10.0.0.2:3128" };
    seedProxyPoolMock({ proxies: [frankfurt, tokyo] });
    const { user } = await renderCard();
    const [first] = await screen.findAllByRole("button", { name: "Remove" });
    await user.click(first);
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.queryByText("Frankfurt")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute("aria-description", "Tokyo"),
    );
    expect(document.activeElement).toHaveAccessibleName("Remove");
  });

  it("shows a failed remove in the card, and Try again removes without asking again", async () => {
    let fail = true;
    mockServer.use(
      http.delete(apiUrl("/proxy-pool/proxies/:id"), () =>
        fail ? HttpResponse.json({ error: "boom" }, { status: 500 }) : undefined,
      ),
    );
    seedProxyPoolMock({ proxies: [frankfurt] });
    const { user } = await renderCard();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );

    const notice = await actionError();
    expect(notice).toHaveTextContent("boom");
    expect(screen.getByText("Frankfurt")).toBeInTheDocument();
    fail = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/No proxies yet/)).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await expectAnnounced("The proxy was removed.");
  });

  it("shows a failed switch in the card until it is closed, then focuses the switch", async () => {
    mockServer.use(
      http.put(apiUrl("/proxy-pool/proxies/:id"), () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    seedProxyPoolMock({ proxies: [frankfurt] });
    const { user } = await renderCard();
    const toggle = await screen.findByRole("switch", { name: "Use Frankfurt" });
    await user.click(toggle);

    const notice = await actionError();
    // The switch goes back to the saved state.
    await waitFor(() => expect(toggle).toBeChecked());
    await user.click(within(notice).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(toggle);
  });

  it("keeps a proxy's switch at its new state, disabled, while it saves", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockServer.use(
      http.put(apiUrl("/proxy-pool/proxies/:id"), async () => {
        await held;
        return undefined;
      }),
    );
    seedProxyPoolMock({ proxies: [frankfurt] });
    const { user } = await renderCard();
    const toggle = await screen.findByRole("switch", { name: "Use Frankfurt" });
    await user.click(toggle);

    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    release();
    expect(await screen.findByText("Off")).toBeInTheDocument();
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
    expect(toggle).not.toBeChecked();
  });

  it("shows a switched-off proxy's failed test in its row", async () => {
    const dead = { ...frankfurt, id: "px_2", label: "Dead", url: "http://127.0.0.1:9" };
    seedProxyPoolMock({ proxies: [{ ...dead, enabled: false }] });
    const { user } = await renderCard();
    await user.click(await screen.findByRole("button", { name: "Test" }));

    expect(
      await screen.findByText(/Switched off\. .* Last error: The proxy refused the connection\./),
    ).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
    await expectAnnounced("Dead is not reachable. The proxy refused the connection.");
  });

  it("never closes the next editor when an earlier one's save ends", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockServer.use(
      http.post(apiUrl("/proxy-pool/proxies"), async () => {
        await held;
        return undefined;
      }),
    );
    const { user } = await renderCard();
    await user.click(screen.getByRole("button", { name: "Add proxy" }));
    let dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Host"), "proxy.local");
    await user.type(within(dialog).getByLabelText("Port"), "1080");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    // Closed while it saves, then opened again: a new, empty form.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Add proxy" }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Host")).toHaveValue("");

    release();
    await expectAnnounced("The proxy was added and is being checked.");
    expect(await screen.findByText("proxy.local:1080", { exact: false })).toBeInTheDocument();
    // Past the old form's "Saved" moment: the new one is still open.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("shows a failed save in the editor and keeps it open", async () => {
    seedProxyPoolMock({ proxies: [frankfurt] });
    const { user } = await renderCard();
    await user.click(screen.getByRole("button", { name: "Add proxy" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Host"), "10.0.0.1");
    await user.type(within(dialog).getByLabelText("Port"), "1080");
    await user.type(within(dialog).getByLabelText("Username"), "bob");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    const notice = await within(dialog).findByRole("alert");
    expect(notice).toHaveTextContent("This proxy is already in the pool.");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("tries a failed settings save again from the card", async () => {
    let fail = true;
    mockServer.use(
      http.put(apiUrl("/proxy-pool/settings"), () =>
        fail ? HttpResponse.json({ error: "boom" }, { status: 500 }) : undefined,
      ),
    );
    seedProxyPoolMock({ proxies: [frankfurt] });
    const { user } = await renderCard();
    const toggle = screen.getByRole("switch", { name: "Use the proxy pool" });
    await user.click(toggle);

    const notice = await actionError();
    expect(toggle).not.toBeChecked();
    fail = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    await expectAnnounced("Your settings were saved.");
    await waitFor(() => expect(toggle).toBeChecked());
    const saves = (await writes()).filter((w) => w.path === "/proxy-pool/settings");
    expect(saves).toHaveLength(2);
  });

  it("shows a failed switch only once the switch is back, so Try again can't overlap it", async () => {
    let hold = false;
    let held = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockServer.use(
      http.put(apiUrl("/proxy-pool/proxies/:id"), () => {
        hold = true;
        return HttpResponse.json({ error: "boom" }, { status: 500 });
      }),
      http.get(apiUrl("/proxy-pool"), async () => {
        if (!hold) return undefined;
        held++;
        await gate;
        return undefined;
      }),
    );
    seedProxyPoolMock({ proxies: [frankfurt] });
    const { user } = await renderCard();
    const toggle = screen.getByRole("switch", { name: "Use Frankfurt" });
    await user.click(toggle);

    await waitFor(() => expect(held).toBe(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    release();
    await actionError();
    expect(toggle).not.toHaveAttribute("aria-disabled");
    expect(toggle).toBeChecked();
  });

  it("takes a failed remove as done when the proxy is gone anyway", async () => {
    mockServer.use(
      http.delete(apiUrl("/proxy-pool/proxies/:id"), () => {
        // It went meanwhile: another tab, or a remove that went through but timed out.
        seedProxyPoolMock({ proxies: [] });
        return HttpResponse.json({ error: "boom" }, { status: 500 });
      }),
    );
    seedProxyPoolMock({ proxies: [frankfurt] });
    const { user } = await renderCard();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );

    expect(await screen.findByText(/No proxies yet/)).toBeInTheDocument();
    await expectAnnounced("The proxy was removed.");
    // No notice for a proxy that is gone, and focus is not left on the page.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toHaveAccessibleName("Add proxy"));
    expect((await writes()).filter((w) => w.method === "DELETE")).toHaveLength(1);
  });

  it("closes a failed test's notice once its proxy is gone, focus with it", async () => {
    const tokyo = { ...frankfurt, id: "px_2", label: "Tokyo", url: "http://10.0.0.2:3128" };
    mockServer.use(
      http.post(apiUrl("/proxy-pool/proxies/:id/check"), () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    seedProxyPoolMock({ proxies: [frankfurt, tokyo] });
    const { user, queryClient } = await renderCard();
    const [testFrankfurt] = screen.getAllByRole("button", { name: "Test" });
    await user.click(testFrankfurt);
    const notice = await actionError();
    within(notice).getByRole("button", { name: "Try again" }).focus();

    // Removed in another tab; this one reads the pool again.
    seedProxyPoolMock({ proxies: [tokyo] });
    await queryClient.invalidateQueries();
    await waitFor(() => expect(screen.queryByText("Frankfurt")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.activeElement).toHaveAccessibleName("Add proxy");
  });

  it("puts a proxy's state note under its whole row, not beside its buttons", async () => {
    const dead = { ...frankfurt, id: "px_2", label: "Dead", url: "http://127.0.0.1:9" };
    seedProxyPoolMock({ proxies: [{ ...dead, enabled: false }, frankfurt] });
    await renderCard();
    const note = await screen.findByText(/^Switched off\./);
    const row = note.previousElementSibling;
    expect(row).toHaveAttribute("data-slot", "settings-row");
    expect(row).toHaveTextContent("Dead");
    expect(within(row as HTMLElement).getByRole("button", { name: "Test" })).toBeInTheDocument();
    // The healthy row has no note.
    const healthy = screen.getByText("Frankfurt").closest('[data-slot="settings-row"]');
    expect(healthy?.nextElementSibling).toBeNull();
  });

  it("still moves focus after a remove when another remove fails meanwhile", async () => {
    const tokyo = { ...frankfurt, id: "px_2", label: "Tokyo", url: "http://10.0.0.2:3128" };
    const paris = { ...frankfurt, id: "px_3", label: "Paris", url: "http://10.0.0.3:3128" };
    seedProxyPoolMock({ proxies: [frankfurt, tokyo, paris] });
    let started = 0;
    let failFrankfurt: () => void = () => {};
    const frankfurtGate = new Promise<void>((resolve) => {
      failFrankfurt = resolve;
    });
    let passTokyo: () => void = () => {};
    const tokyoGate = new Promise<void>((resolve) => {
      passTokyo = resolve;
    });
    mockServer.use(
      http.delete(apiUrl("/proxy-pool/proxies/:id"), async ({ params }) => {
        started++;
        if (params.id === "px_1") {
          await frankfurtGate;
          return HttpResponse.json({ error: "boom" }, { status: 500 });
        }
        await tokyoGate;
        return undefined;
      }),
    );
    const { user } = await renderCard();
    const [removeFrankfurt, removeTokyo] = screen.getAllByRole("button", { name: "Remove" });
    for (const button of [removeFrankfurt, removeTokyo]) {
      await user.click(button);
      const confirm = await screen.findByRole("alertdialog");
      await user.click(within(confirm).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    }
    await waitFor(() => expect(started).toBe(2));

    failFrankfurt();
    await actionError();
    passTokyo();
    await waitFor(() => expect(screen.queryByText("Tokyo")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute("aria-description", "Paris"),
    );
  });

  it("takes a proxy out after three failed checks in a row", async () => {
    const dead = { ...frankfurt, id: "px_2", label: "Dead", url: "http://127.0.0.1:9" };
    seedProxyPoolMock({ proxies: [frankfurt, dead] });
    const { user } = await renderCard();
    const strikes = [/Failed 1 time in a row\./, /Failed 2 times in a row\./, /Failed 3 times/];
    for (const strike of strikes) {
      await user.click(await screen.findByRole("button", { name: "Check all" }));
      expect(await screen.findByText(strike)).toBeInTheDocument();
    }
    expect(await screen.findByText("Auto-disabled")).toBeInTheDocument();
    expect(
      screen.getByText(/Failed 3 times in a row, so it is out of rotation until a check passes\./),
    ).toBeInTheDocument();
    expect(screen.getByText("1 auto-disabled")).toBeInTheDocument();
    expect(screen.getByText("1 healthy")).toBeInTheDocument();
  });

  it("switches a proxy off and on with its own switch", async () => {
    seedProxyPoolMock({ proxies: [frankfurt], assignments: { a1: "px_1" } });
    const { user } = await renderCard();
    const toggle = await screen.findByRole("switch", { name: "Use Frankfurt" });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    expect(await screen.findByText("Off")).toBeInTheDocument();
    await expectAnnounced("Frankfurt is off. Its accounts moved to other proxies.");
    expect(
      screen.getByText("Switched off. It is not used or checked until you switch it on."),
    ).toBeInTheDocument();
    expect(await writes()).toEqual([
      { method: "PUT", path: "/proxy-pool/proxies/px_1", body: { enabled: false } },
    ]);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Use Frankfurt" })).not.toBeChecked(),
    );
  });

  it("lists detected proxies and adds only an unauthenticated one to the pool", async () => {
    mockDb.proxy.proxyURL = "socks5://user:p%40ss@127.0.0.1:1080";
    mockDb.accounts[0].proxyURL = "http://open.example:8080";
    const { user } = await renderCard();

    expect(await screen.findByText("Detected proxies")).toBeInTheDocument();
    expect(screen.getByText("Global proxy")).toBeInTheDocument();
    expect(screen.getByText("Own proxy of 1 account")).toBeInTheDocument();
    expect(screen.getByText("Has a sign-in, so it is never shared")).toBeInTheDocument();
    expect(screen.queryByText(/p@ss|p%40ss/)).not.toBeInTheDocument();
    // Only the open proxy offers Add to pool.
    const adopt = screen.getAllByRole("button", { name: "Add to pool" });
    expect(adopt).toHaveLength(1);
    await user.click(adopt[0]);
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Add to pool" }));

    expect(await screen.findByText("Also in the pool")).toBeInTheDocument();
    await expectAnnounced("http://open.example:8080 was added to the pool and is being checked.");
    // Add to pool went with the result: focus is on the row's Test, not the page.
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute(
        "aria-description",
        "http://open.example:8080",
      ),
    );
    expect(document.activeElement).toHaveAccessibleName("Test");
    const adoptWrites = (await writes()).filter((w) => w.path.endsWith("/adopt"));
    expect(adoptWrites).toHaveLength(1);
    expect(adoptWrites[0].path).toMatch(/^\/proxy-pool\/detected\/dx_[0-9a-f]+\/adopt$/);
  });
});
