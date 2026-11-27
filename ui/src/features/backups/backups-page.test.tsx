import { act, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInReasonNotice, useSignInReason } from "@/features/auth/sign-in-reason";
import { subscribeAnnouncements } from "@/lib/announce";
import { settingsQuery } from "@/lib/api/settings";
import { tunnelQuery } from "@/lib/api/tunnel";
import type { BackupEntry } from "@/lib/api/types";
import { getSession, type SessionChangeReason, subscribeSession } from "@/lib/auth/session";
import { saveBlob } from "@/lib/download";
import { formatDateTime } from "@/lib/format";
import { mockDb } from "@/lib/mocks/db";
import { makeBackupEntry } from "@/lib/mocks/fixtures";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderApp, renderWithProviders } from "@/test/render";
import { BackupsPage } from "./backups-page";

/** The admin sign-in page's notice, as it reads the reason the restore marked. */
function AdminSignInNotice() {
  const { reason } = useSignInReason("admin");
  return <SignInReasonNotice reason={reason} />;
}

vi.mock("@/lib/download", () => ({ saveBlob: vi.fn(), saveJson: vi.fn() }));

const sessionEvents: SessionChangeReason[] = [];
let unsubscribe: () => void = () => {};

/*
 * The list renders its table and its cards, and a container query shows one (jsdom has no
 * layout). This sheet stands in for it: it hides the other layout, so role queries and focus
 * see what a browser would.
 */
const layoutSheet = document.createElement("style");
function showLayout(layout: "table" | "cards"): void {
  const hidden = layout === "table" ? "data-table-cards" : "data-table-view";
  layoutSheet.textContent = `[data-slot="${hidden}"] { display: none; }`;
}

beforeEach(() => {
  sessionEvents.length = 0;
  document.head.append(layoutSheet);
  showLayout("table");
});

afterEach(() => {
  unsubscribe();
  layoutSheet.remove();
  vi.restoreAllMocks();
  vi.mocked(saveBlob).mockReset();
});

function newestFirst(): BackupEntry[] {
  return [...mockDb.backups].sort((a, b) => b.createdAt - a.createdAt);
}

/** Data rows of the backups table, header excluded. */
function dataRows(): HTMLElement[] {
  const table = screen.getByRole("table", { name: "Backups, newest first" });
  return within(table).getAllByRole("row").slice(1);
}

/** Presses one of a table row's icon buttons (named by aria-label). */
async function rowAction(
  user: UserEvent,
  row: HTMLElement,
  name: "Download" | "Restore" | "Delete",
): Promise<void> {
  await user.click(within(row).getByRole("button", { name }));
}

/** Renders the page, waits for the rows, then records session changes from here on. */
async function renderPage() {
  const view = renderWithProviders(<BackupsPage />);
  await screen.findAllByRole("button", { name: "Download" });
  unsubscribe = subscribeSession((_session, reason) => sessionEvents.push(reason));
  return view;
}

/** Said to a screen reader through the app's live region. */
async function expectAnnounced(text: string): Promise<void> {
  const line = await screen.findByText(text);
  expect(line.closest('[data-slot="live-announcer"]')).not.toBeNull();
}

/** Records what is announced from here on; call it after renderPage. */
function recordAnnouncements(): string[] {
  const texts: string[] = [];
  const stopSession = unsubscribe;
  const stop = subscribeAnnouncements(({ text }) => texts.push(text));
  unsubscribe = () => {
    stopSession();
    stop();
  };
  return texts;
}

/** The notice for a failed action (one plain line with the server's reason). */
async function actionError(): Promise<HTMLElement> {
  return waitFor(() => {
    const notice = document.querySelector<HTMLElement>('[data-slot="action-error"]');
    if (!notice) throw new Error("no failure notice");
    return notice;
  });
}

function noActionError(): void {
  expect(document.querySelector('[data-slot="action-error"]')).toBeNull();
}

function listCard(): HTMLElement {
  return screen.getByRole("region", { name: "Saved backups" });
}

function scheduleCard(): HTMLElement {
  return screen.getByRole("region", { name: "Schedule" });
}

const RESTORE_BODY =
  "Current accounts and settings are replaced. A rollback point is saved first. You will be signed out.";

function dialog(): HTMLElement {
  return screen.getByRole("alertdialog");
}

/** Adds `count` older manual backups, so the list takes more than one page. */
function addOlderBackups(count: number): void {
  const oldest = Math.min(...mockDb.backups.map((row) => row.createdAt));
  for (let i = 1; i <= count; i += 1) {
    mockDb.backups.push(makeBackupEntry({ createdAt: oldest - i * 3600 }));
  }
}

/** Holds a request until `release()`, then lets the default handler answer it. */
function gate(): { wait: () => Promise<undefined>; release: () => void } {
  let release: () => void = () => {};
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    wait: async () => {
      await open;
      return undefined;
    },
    release,
  };
}

function currentPage(): string | null {
  return document.querySelector('[aria-current="page"]')?.getAttribute("aria-label") ?? null;
}

describe("BackupsPage", () => {
  it("lists the seeded backups newest first with kind badges", async () => {
    await renderPage();
    const rows = dataRows();
    expect(rows).toHaveLength(5);
    const kinds = rows.map((row) => row.querySelector('[data-slot="badge"]')?.textContent);
    expect(kinds).toEqual(["Manual", "Scheduled", "Rollback point", "Scheduled", "Rollback point"]);
    const rollback = within(rows[2]).getByText("Rollback point");
    expect(rollback).toHaveAttribute("data-tone", "warning");
    expect(within(rows[0]).getByText("Manual")).toHaveAttribute("data-tone", "primary");
    expect(within(rows[1]).getByText("Scheduled")).toHaveAttribute("data-tone", "neutral");
    expect(within(rows[1]).getByText("Every day")).toBeInTheDocument();
    expect(within(rows[2]).getByText("7 restored")).toBeInTheDocument();
    expect(within(rows[4]).getByText("Before restoring kiro-backup-x.json")).toBeInTheDocument();
  });

  it("shows the empty state when the server sends backups:null", async () => {
    mockServer.use(http.get(apiUrl("/backups"), () => HttpResponse.json({ backups: null })));
    renderWithProviders(<BackupsPage />);
    expect(await screen.findByText("No backups yet")).toBeInTheDocument();
    expect(screen.getByText("Create a backup before you change accounts.")).toBeInTheDocument();
    // The card header's Create backup is the only one: the empty state does not repeat it.
    expect(screen.getAllByRole("button", { name: "Create backup" })).toHaveLength(1);
  });

  it("shows an error state when the list fails to load", async () => {
    mockServer.use(
      http.get(apiUrl("/backups"), () =>
        HttpResponse.json({ error: "db locked" }, { status: 500 }),
      ),
    );
    renderWithProviders(<BackupsPage />);
    expect(await screen.findByText("Could not load backups")).toBeInTheDocument();
    expect(screen.getByText("db locked")).toBeInTheDocument();
  });

  it("creates a manual backup with a generated note", async () => {
    let body: unknown = null;
    mockServer.use(
      http.post(apiUrl("/backups"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ backup: makeBackupEntry() });
      }),
    );
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Create backup" }));
    await expectAnnounced("The backup was created.");
    expect(body).toEqual({
      kind: "manual",
      note: expect.stringMatching(/^manual backup \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    });
  });

  it("saves the schedule with keep clamped to 200", async () => {
    let body: unknown = null;
    mockServer.use(
      http.post(apiUrl("/backups/schedule"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ success: true });
      }),
    );
    const { user } = await renderPage();
    const keep = await screen.findByRole("textbox", { name: "Keep latest" });
    expect(keep).toHaveAccessibleDescription("Keep 1–200. Older scheduled backups are deleted.");
    expect(keep).toHaveValue("14");
    await user.clear(keep);
    await user.type(keep, "500");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await expectAnnounced("The schedule was saved.");
    expect(body).toEqual({ enabled: true, cadence: "daily", keep: 200 });
  });

  it("marks the Keep field when the server rejects keep, without a card notice", async () => {
    mockServer.use(
      http.post(apiUrl("/backups/schedule"), () =>
        HttpResponse.json(
          { error: "keep must be between 1 and 200", code: "invalid_keep" },
          { status: 400 },
        ),
      ),
    );
    const { user } = await renderPage();
    const announced = recordAnnouncements();
    const keep = await screen.findByRole("textbox", { name: "Keep latest" });
    await user.clear(keep);
    await user.type(keep, "30");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const error = await screen.findByText("Enter a whole number from 1 to 200.", {
      selector: '[data-slot="field-error"]',
    });
    expect(keep).toHaveAttribute("aria-invalid", "true");
    expect(keep).toHaveAccessibleDescription(
      "Keep 1–200. Older scheduled backups are deleted. Enter a whole number from 1 to 200.",
    );
    // In the row's full-width notice slot under the text and the field, not in its text column.
    const row = keep.closest<HTMLElement>('[data-slot="settings-row"]');
    expect(row).not.toBeNull();
    expect(error.parentElement?.parentElement).toBe(row);
    expect(error.parentElement).not.toContainElement(keep);
    // Focus stays on Save, so a screen reader hears it this way.
    expect(announced).toEqual(["Enter a whole number from 1 to 200."]);
    noActionError();
    // Editing the value clears the mark.
    await user.type(keep, "1");
    expect(error).not.toBeInTheDocument();
  });

  it("downloads a backup through saveBlob with the server file name", async () => {
    const { user } = await renderPage();
    const [first] = newestFirst();
    await user.click(within(dataRows()[0]).getByRole("button", { name: "Download" }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    const [blob, filename] = vi.mocked(saveBlob).mock.calls[0];
    expect(blob.type).toBe("application/json");
    expect(JSON.parse(await blob.text())).toMatchObject({
      format: "kiro-proxy-backup",
      version: 1,
    });
    expect(filename).toBe(`kiro-backup-${first.id}.json`);
  });

  it("restores a backup only after confirmation, then signs out", async () => {
    const restored: string[] = [];
    mockServer.use(
      http.post(apiUrl("/backups/:id/restore"), ({ params }) => {
        restored.push(String(params.id));
        return HttpResponse.json({ success: true });
      }),
    );
    const order: string[] = [];
    const { user } = await renderPage();
    unsubscribe();
    const unsubscribeSession = subscribeSession((_session, reason) =>
      order.push(`session:${reason}`),
    );
    const unsubscribeAnnouncements = subscribeAnnouncements(({ text }) =>
      order.push(`announce:${text}`),
    );
    unsubscribe = () => {
      unsubscribeSession();
      unsubscribeAnnouncements();
    };
    const [first] = newestFirst();
    await rowAction(user, dataRows()[0], "Restore");
    expect(dialog()).toHaveAccessibleName(
      `Restore the backup from ${formatDateTime(first.createdAt, "en")}?`,
    );
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(restored).toEqual([]);
    expect(getSession()).not.toBeNull();

    await rowAction(user, dataRows()[0], "Restore");
    await user.click(within(dialog()).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(order).toContain("session:restored"));
    expect(restored).toEqual([first.id]);
    // The sign-in page says the backup was restored (routes/-guards.test.tsx), nothing here.
    expect(order).toEqual(["session:restored"]);
    expect(getSession()).toBeNull();
  });

  it("warns, before a restore through the public link, that the page may disconnect", async () => {
    // proxy/backups_api.go: the restored link settings apply once the answer is out.
    mockServer.use(
      http.get(apiUrl("/tunnel"), () =>
        HttpResponse.json({ state: "running", enabled: true, viaLink: true }),
      ),
    );
    const { user, queryClient } = await renderPage();
    await waitFor(() =>
      expect(queryClient.getQueryData(tunnelQuery().queryKey)?.viaLink).toBe(true),
    );
    await rowAction(user, dataRows()[0], "Restore");
    expect(dialog()).toHaveAccessibleDescription(
      `${RESTORE_BODY} You opened this page through the public link. If the backup's public link settings differ, this page disconnects: sign in again from the local address.`,
    );
  });

  it("says nothing about the link when the page did not come through it", async () => {
    const { user, queryClient } = await renderPage();
    await waitFor(() =>
      expect(queryClient.getQueryData(tunnelQuery().queryKey)?.viaLink).toBe(false),
    );
    await rowAction(user, dataRows()[0], "Restore");
    expect(dialog()).toHaveAccessibleDescription(RESTORE_BODY);
  });

  it("tells the sign-in page that ADMIN_PASSWORD kept its password over the backup's", async () => {
    mockDb.settings = { ...mockDb.settings, adminPasswordFromEnv: true };
    const { user, queryClient } = await renderPage();
    await waitFor(() =>
      expect(queryClient.getQueryData(settingsQuery().queryKey)?.adminPasswordFromEnv).toBe(true),
    );
    await rowAction(user, dataRows()[0], "Restore");
    await user.click(within(dialog()).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(sessionEvents).toEqual(["restored"]));
    renderWithProviders(<AdminSignInNotice />);
    expect(
      screen.getByText(
        "Backup restored. Sign in with the ADMIN_PASSWORD password: the restore kept it, not the backup's.",
      ),
    ).toBeInTheDocument();
  });

  it("shows a failed restore's server message verbatim in the list card and keeps the session", async () => {
    let fail = true;
    mockServer.use(
      http.post(apiUrl("/backups/:id/restore"), ({ params }) =>
        fail
          ? HttpResponse.json({ error: `backup not found: ${params.id}` }, { status: 500 })
          : undefined,
      ),
    );
    const { user } = await renderPage();
    const [first] = newestFirst();
    await rowAction(user, dataRows()[0], "Restore");
    await user.click(within(dialog()).getByRole("button", { name: "Restore" }));
    const notice = await actionError();
    expect(notice).toHaveTextContent(`backup not found: ${first.id}`);
    expect(listCard()).toContainElement(notice);
    expect(sessionEvents).toEqual([]);
    // Try again restores without asking again, and the restore signs out.
    fail = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(sessionEvents).toEqual(["restored"]));
  });

  it("explains a rejected upload in words, keeps the raw reason as a detail and the session", async () => {
    const { user } = await renderPage();
    const input = screen.getByTestId("backup-upload-input") as HTMLInputElement;
    const file = new File(["not json at all"], "broken.json", { type: "application/json" });
    await user.upload(input, file);
    expect(input.value).toBe("");
    expect(
      within(dialog()).getByRole("heading", { name: "Restore from broken.json?" }),
    ).toBeInTheDocument();
    await user.click(within(dialog()).getByRole("button", { name: "Restore" }));
    const notice = await actionError();
    expect(notice).toHaveTextContent(
      "It is not a Kiro Proxy backup. Choose a file you downloaded from Backups. Details: backup content is not valid JSON",
    );
    // The same file fails the same way: only Close.
    expect(within(notice).queryByRole("button", { name: "Try again" })).toBeNull();
    await user.click(within(notice).getByRole("button", { name: "Close" }));
    noActionError();
    expect(screen.getByRole("button", { name: "Restore from file" })).toHaveFocus();
    expect(sessionEvents).toEqual([]);
    expect(getSession()).not.toBeNull();
  });

  it("maps the wrong-format upload error the same way", async () => {
    const { user } = await renderPage();
    const input = screen.getByTestId("backup-upload-input") as HTMLInputElement;
    await user.upload(input, new File([JSON.stringify({ hello: "world" })], "other.json"));
    await user.click(within(dialog()).getByRole("button", { name: "Restore" }));
    expect(await actionError()).toHaveTextContent(
      "It is not a Kiro Proxy backup. Choose a file you downloaded from Backups. Details: unsupported backup format: expected kiro-proxy-backup",
    );
  });

  it("shows an unknown upload error verbatim, and Try again sends the same file", async () => {
    const sent: string[] = [];
    mockServer.use(
      http.post(apiUrl("/backups/restore"), async ({ request }) => {
        const file = (await request.formData()).get("file");
        sent.push(typeof file === "string" || !file ? "" : await file.text());
        return HttpResponse.json(
          { error: "pre-restore snapshot failed: disk full" },
          { status: 500 },
        );
      }),
    );
    const { user } = await renderPage();
    const input = screen.getByTestId("backup-upload-input") as HTMLInputElement;
    await user.upload(input, new File(['{"x":1}'], "x.json"));
    await user.click(within(dialog()).getByRole("button", { name: "Restore" }));
    const notice = await actionError();
    expect(notice).toHaveTextContent("pre-restore snapshot failed: disk full");
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent).toEqual(['{"x":1}', '{"x":1}']));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore from file" })).toHaveFocus();
  });

  it("restores from a valid file, then signs out", async () => {
    const { user } = await renderPage();
    const input = screen.getByTestId("backup-upload-input") as HTMLInputElement;
    const backup = {
      format: "kiro-proxy-backup",
      version: 1,
      createdAt: 1,
      config: { password: "secret-pass", accounts: [{ id: "a" }, { id: "b" }] },
      credentialsLoaded: false,
    };
    await user.upload(input, new File([JSON.stringify(backup)], "good.json"));
    await user.click(within(dialog()).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(sessionEvents).toEqual(["restored"]));
    const rollback = mockDb.backups.find(
      (row) => row.kind === "pre-restore" && row.restoredAccountCnt === 2,
    );
    expect(rollback?.note).toMatch(/^upload /);
  });

  it("rejects an upload over 32 MB before sending it, naming the file's size", async () => {
    let sent = false;
    mockServer.use(
      http.post(apiUrl("/backups/restore"), () => {
        sent = true;
        return HttpResponse.json({ success: true });
      }),
    );
    const { user } = await renderPage();
    const input = screen.getByTestId("backup-upload-input") as HTMLInputElement;
    const file = new File(["{}"], "huge.json", { type: "application/json" });
    Object.defineProperty(file, "size", { value: 40.5 * 1024 * 1024 });
    await user.upload(input, file);
    const notice = await actionError();
    // Testing Library reads the size's no-break space as a plain space.
    expect(notice).toHaveTextContent(
      "The file is 40.5 MB, over the 32 MB limit. Choose a smaller backup file.",
    );
    expect(within(notice).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(sent).toBe(false);
  });

  it("deletes a backup after confirmation and refetches the list", async () => {
    const { user } = await renderPage();
    const [first] = newestFirst();
    await rowAction(user, dataRows()[0], "Delete");
    expect(dialog()).toHaveAccessibleName(
      `Delete the backup from ${formatDateTime(first.createdAt, "en")}?`,
    );
    expect(
      within(dialog()).getByText(
        "The backup file is removed from the server. This cannot be undone.",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    await expectAnnounced("The backup was deleted.");
    await waitFor(() => expect(dataRows()).toHaveLength(4));
    expect(mockDb.backups.some((row) => row.id === first.id)).toBe(false);
  });

  it("shows a failed create in the list card, and Try again creates the backup", async () => {
    let fail = true;
    mockServer.use(
      http.post(apiUrl("/backups"), () =>
        fail ? HttpResponse.json({ error: "disk full" }, { status: 500 }) : undefined,
      ),
    );
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Create backup" }));
    const notice = await actionError();
    expect(notice).toHaveTextContent("disk full");
    expect(listCard()).toContainElement(notice);
    expect(dataRows()).toHaveLength(5);
    fail = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(dataRows()).toHaveLength(6));
    noActionError();
    await expectAnnounced("The backup was created.");
    expect(screen.getByRole("button", { name: "Create backup" })).toHaveFocus();
  });

  it("drops a row's failure once that backup is gone, moving focus out of it", async () => {
    mockServer.use(
      http.get(apiUrl("/backups/:id/download"), () =>
        HttpResponse.json({ error: "read backup: busy" }, { status: 500 }),
      ),
    );
    const { user, queryClient } = await renderPage();
    const [first] = newestFirst();
    await rowAction(user, dataRows()[0], "Download");
    const notice = await actionError();
    expect(notice).toHaveTextContent("read backup: busy");
    act(() => within(notice).getByRole("button", { name: "Close" }).focus());
    // Deleted elsewhere: the list refetches without it, and Try again has nothing to fetch.
    mockDb.backups.splice(
      mockDb.backups.findIndex((row) => row.id === first.id),
      1,
    );
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(dataRows()).toHaveLength(4));
    noActionError();
    expect(screen.getByRole("button", { name: "Create backup" })).toHaveFocus();
  });

  it("keeps a backup whose delete failed, and Close moves focus to its row", async () => {
    mockServer.use(
      http.delete(apiUrl("/backups/:id"), () =>
        HttpResponse.json({ error: "remove backup: busy" }, { status: 500 }),
      ),
    );
    const { user } = await renderPage();
    const [, second] = newestFirst();
    await rowAction(user, dataRows()[1], "Delete");
    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    const notice = await actionError();
    expect(notice).toHaveTextContent("remove backup: busy");
    expect(dataRows()).toHaveLength(5);
    await user.click(within(notice).getByRole("button", { name: "Close" }));
    noActionError();
    const download = within(dataRows()[1]).getByRole("button", { name: "Download" });
    expect(download).toHaveAttribute("data-row-focus", second.id);
    expect(download).toHaveFocus();
  });
});

describe("BackupsPage layout", () => {
  it("shows the count and total size in the card header, with Refresh and Create there", async () => {
    await renderPage();
    const card = screen.getByRole("region", { name: "Saved backups" });
    expect(within(card).getByText(/^5 backups · /)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Create backup" })).toBeInTheDocument();
  });

  it("renders cards in a narrow container, every action one tap away in the menu", async () => {
    showLayout("cards");
    const { user } = renderWithProviders(<BackupsPage />);
    const list = await screen.findByRole("list", { name: "Backups, newest first" });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(5);
    await user.click(within(cards[0]).getByRole("button", { name: /^Actions for backup / }));
    for (const name of ["Download", "Restore", "Delete"]) {
      expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument();
    }
  });

  it("renders the table in a wide container, with icon-only row actions", async () => {
    await renderPage();
    const row = dataRows()[0];
    for (const name of ["Download", "Restore", "Delete"]) {
      const button = within(row).getByRole("button", { name });
      // The name is the aria-label; the button shows only its icon.
      expect(button.textContent?.trim()).toBe("");
    }
    expect(screen.queryByRole("list", { name: "Backups, newest first" })).not.toBeInTheDocument();
  });

  it("deletes from a card's menu and moves focus to the next card's menu", async () => {
    showLayout("cards");
    const { user } = renderWithProviders(<BackupsPage />);
    const list = await screen.findByRole("list", { name: "Backups, newest first" });
    const [first] = newestFirst();
    const card = within(list).getAllByRole("listitem")[0];
    await user.click(within(card).getByRole("button", { name: /^Actions for backup / }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(4));
    expect(mockDb.backups.some((row) => row.id === first.id)).toBe(false);
    const next = within(within(list).getAllByRole("listitem")[0]).getByRole("button", {
      name: /^Actions for backup /,
    });
    await waitFor(() => expect(next).toHaveFocus());
  });

  it("opens a row hint on tap, so touch users can read it", async () => {
    const { user } = await renderPage();
    const trigger = within(dataRows()[2]).getByRole("button", { name: "7 restored" });
    await user.click(trigger);
    expect(
      await screen.findByText(/^Rollback point saved \d+ accounts? before the restore\.$/),
    ).toBeInTheDocument();
  });
});

describe("BackupsPage focus", () => {
  it("keeps focus on Create backup while it is pending and ignores a second press", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockServer.use(
      http.post(apiUrl("/backups"), async () => {
        calls += 1;
        await gate;
        return HttpResponse.json({ backup: makeBackupEntry() });
      }),
    );
    const { user } = await renderPage();
    const pending = screen.getByRole("button", { name: "Create backup" });
    await user.click(pending);
    // The label stays while it works; only the spinner and aria-busy say so.
    await waitFor(() => expect(pending).toHaveAttribute("aria-busy", "true"));
    expect(pending).toHaveAccessibleName("Create backup");
    expect(pending).not.toBeDisabled();
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending).toHaveFocus();
    await user.click(pending);
    release();
    await expectAnnounced("The backup was created.");
    expect(calls).toBe(1);
    expect(screen.getByRole("button", { name: "Create backup" })).toHaveFocus();
  });

  it("shows a new backup on the first page when Create is pressed on another", async () => {
    addOlderBackups(10);
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Page 2" }));
    expect(dataRows()).toHaveLength(5);
    await user.click(screen.getByRole("button", { name: "Create backup" }));
    await expectAnnounced("The backup was created.");
    expect(currentPage()).toBe("Page 1");
  });

  it("stays on the page the user went to while a backup was being created", async () => {
    addOlderBackups(10);
    const create = gate();
    mockServer.use(http.post(apiUrl("/backups"), create.wait));
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Create backup" }));
    await user.click(screen.getByRole("button", { name: "Page 2" }));
    create.release();
    await expectAnnounced("The backup was created.");
    // The refetch adds it to the top of page 1, so page 2 gains a row.
    await waitFor(() => expect(dataRows()).toHaveLength(6));
    expect(currentPage()).toBe("Page 2");
  });

  it("keeps the page and the focused row when focus went into the list while creating", async () => {
    addOlderBackups(10);
    const create = gate();
    mockServer.use(http.post(apiUrl("/backups"), create.wait));
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Page 2" }));
    await user.click(screen.getByRole("button", { name: "Create backup" }));
    const download = within(dataRows()[0]).getByRole("button", { name: "Download" });
    act(() => download.focus());
    create.release();
    await expectAnnounced("The backup was created.");
    await waitFor(() => expect(dataRows()).toHaveLength(6));
    expect(currentPage()).toBe("Page 2");
    expect(download).toHaveFocus();
  });

  it("keeps focus on Refresh while the list reloads", async () => {
    const { user } = await renderPage();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockServer.use(
      http.get(apiUrl("/backups"), async () => {
        await gate;
        return HttpResponse.json({ backups: newestFirst() });
      }),
    );
    const refresh = screen.getByRole("button", { name: "Refresh" });
    await user.click(refresh);
    await waitFor(() => expect(refresh).toHaveAttribute("aria-disabled", "true"));
    expect(refresh).not.toBeDisabled();
    expect(refresh).toHaveFocus();
    release();
    await waitFor(() => expect(refresh).not.toHaveAttribute("aria-disabled"));
    expect(refresh).toHaveFocus();
  });

  it("keeps focus on Download and shows the plain-text warning after a download", async () => {
    const { user } = await renderPage();
    const download = within(dataRows()[0]).getByRole("button", { name: "Download" });
    await user.click(download);
    expect(download).not.toBeDisabled();
    const notice = await screen.findByTestId("backup-downloaded");
    expect(notice).toHaveRole("alert");
    expect(notice).toHaveTextContent(
      "The backup was downloaded. The file contains passwords and tokens in plain text. Store it safely.",
    );
    expect(listCard()).toContainElement(notice);
    expect(saveBlob).toHaveBeenCalledTimes(1);
    expect(download).toHaveFocus();
    // Close goes with the line; focus stays on the row.
    await user.click(within(notice).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("backup-downloaded")).toBeNull();
    expect(download).toHaveFocus();
  });

  it("moves focus to the next row's first action after a delete", async () => {
    const { user } = await renderPage();
    const [, second] = newestFirst();
    await rowAction(user, dataRows()[0], "Delete");
    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(dataRows()).toHaveLength(4));
    const next = within(dataRows()[0]).getByRole("button", { name: "Download" });
    expect(next).toHaveAttribute("data-row-focus", second.id);
    await waitFor(() => expect(next).toHaveFocus());
  });

  it("moves focus to the row above when the last row is deleted", async () => {
    const { user } = await renderPage();
    await rowAction(user, dataRows()[4], "Delete");
    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(dataRows()).toHaveLength(4));
    const above = within(dataRows()[3]).getByRole("button", { name: "Download" });
    await waitFor(() => expect(above).toHaveFocus());
  });

  it("moves focus to the header's Create backup after deleting the only backup", async () => {
    mockDb.backups.splice(1);
    const { user } = await renderPage();
    await rowAction(user, dataRows()[0], "Delete");
    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("No backups yet")).toBeInTheDocument();
    const card = screen.getByRole("region", { name: "Saved backups" });
    const create = within(card).getByRole("button", { name: "Create backup" });
    await waitFor(() => expect(create).toHaveFocus());
  });
});

describe("ScheduleCard", () => {
  it("keeps Save focusable but inactive until a field changes, and sends nothing when clean", async () => {
    let posts = 0;
    mockServer.use(
      http.post(apiUrl("/backups/schedule"), () => {
        posts += 1;
        return HttpResponse.json({ success: true });
      }),
    );
    const { user } = await renderPage();
    const save = await screen.findByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).not.toBeDisabled();
    await user.click(save);
    expect(posts).toBe(0);

    await user.click(screen.getByRole("switch", { name: "Scheduled backup" }));
    expect(save).not.toHaveAttribute("aria-disabled");
    await user.click(screen.getByRole("switch", { name: "Scheduled backup" }));
    expect(save).toHaveAttribute("aria-disabled", "true");
  });

  it("turns Frequency and Keep latest off while the schedule is off, as nothing reads them then", async () => {
    const { user } = await renderPage();
    const toggle = screen.getByRole("switch", { name: "Scheduled backup" });
    const frequency = screen.getByRole("combobox", { name: "Frequency" });
    const keep = screen.getByRole("textbox", { name: "Keep latest" });
    expect(toggle).toBeChecked();
    expect(frequency).not.toHaveAttribute("data-disabled");
    expect(keep).toBeEnabled();

    await user.click(toggle);
    expect(frequency).toHaveAttribute("data-disabled");
    expect(keep).toBeDisabled();
    // Each says why, in its row's description.
    const why = "Turn on Scheduled backup to change this.";
    expect(frequency).toHaveAccessibleDescription(why);
    expect(keep).toHaveAccessibleDescription(why);
  });

  it("saves the stored Frequency and Keep latest when the schedule is turned off", async () => {
    const posts: unknown[] = [];
    mockServer.use(
      http.post(apiUrl("/backups/schedule"), async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json({ success: true });
      }),
    );
    const { user } = await renderPage();
    const keep = screen.getByRole("textbox", { name: "Keep latest" });
    await user.clear(keep);
    await user.type(keep, "30");
    await user.click(screen.getByRole("combobox", { name: "Frequency" }));
    await user.click(await screen.findByRole("option", { name: "Weekly" }));
    await user.click(screen.getByRole("switch", { name: "Scheduled backup" }));
    // A field that is off shows what is saved.
    expect(keep).toHaveValue("14");
    expect(screen.getByRole("combobox", { name: "Frequency" })).toHaveTextContent("Daily");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts).toEqual([{ enabled: false, cadence: "daily", keep: 14 }]));
  });

  it("leaves Save inactive once a schedule that was off is off again, edits and all", async () => {
    mockDb.schedule = { enabled: false, cadence: "daily", keep: 14 };
    const { user } = await renderPage();
    const toggle = screen.getByRole("switch", { name: "Scheduled backup" });
    const save = screen.getByRole("button", { name: "Save" });
    await user.click(toggle);
    const keep = screen.getByRole("textbox", { name: "Keep latest" });
    await user.clear(keep);
    expect(save).not.toHaveAttribute("aria-disabled");
    await user.click(toggle);
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(keep).toHaveValue("14");
  });

  it("keeps focus on Save after saving instead of remounting the form", async () => {
    const { user } = await renderPage();
    const keep = await screen.findByRole("textbox", { name: "Keep latest" });
    await user.clear(keep);
    await user.type(keep, "30");
    const save = screen.getByRole("button", { name: "Save" });
    await user.click(save);
    await expectAnnounced("The schedule was saved.");
    // Save reads "Saved" with a tick for a moment.
    await waitFor(() => expect(save).toHaveAccessibleName("Saved"));
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).toBeInTheDocument();
    expect(save).toHaveFocus();
    expect(keep).toHaveValue("30");
  });

  it("warns, and still re-seeds, when the schedule saved but its prune failed", async () => {
    let posts = 0;
    mockServer.use(
      http.post(apiUrl("/backups/schedule"), async ({ request }) => {
        posts += 1;
        const body = (await request.json()) as typeof mockDb.schedule;
        // Saved: the refetch after the save reads it back.
        mockDb.schedule = { ...mockDb.schedule, ...body };
        return HttpResponse.json({ schedule: body, pruneError: "remove backup: disk full" });
      }),
    );
    const { user } = await renderPage();
    const announced = recordAnnouncements();
    const keep = await screen.findByRole("textbox", { name: "Keep latest" });
    await user.clear(keep);
    await user.type(keep, "5");
    const save = screen.getByRole("button", { name: "Save" });
    await user.click(save);
    const notice = await screen.findByTestId("schedule-prune-failed");
    expect(notice).toHaveRole("alert");
    expect(notice).toHaveTextContent(
      "Scheduled backups over the Keep latest count are still stored. The next save or scheduled run tries again. Details: remove backup: disk full",
    );
    expect(scheduleCard()).toContainElement(notice);
    await waitFor(() => expect(save).toHaveAccessibleName("Saved"));
    expect(keep).toHaveValue("5");
    // The warning is read out as it appears, in place of "saved".
    expect(announced).toEqual([]);
    // Try again saves once more, which retries the delete; focus goes to Save.
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(posts).toBe(2));
    expect(save).toHaveFocus();
    expect(await screen.findByTestId("schedule-prune-failed")).toBeInTheDocument();
  });

  it("retries a failed prune with the stored schedule, leaving a later edit unsaved", async () => {
    const bodies: unknown[] = [];
    mockServer.use(
      http.post(apiUrl("/backups/schedule"), async ({ request }) => {
        const body = (await request.json()) as typeof mockDb.schedule;
        bodies.push(body);
        mockDb.schedule = { ...mockDb.schedule, ...body };
        return HttpResponse.json({ schedule: body, pruneError: "remove backup: disk full" });
      }),
    );
    const { user } = await renderPage();
    const keep = await screen.findByRole("textbox", { name: "Keep latest" });
    await user.clear(keep);
    await user.type(keep, "5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const notice = await screen.findByTestId("schedule-prune-failed");
    // A lower keep typed since would delete more backups: Try again must not save it.
    await user.clear(keep);
    await user.type(keep, "2");
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ enabled: true, cadence: "daily", keep: 5 });
    await screen.findByTestId("schedule-prune-failed");
    expect(keep).toHaveValue("2");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("shows a failed save in the card, and Try again sends the form again", async () => {
    let fail = true;
    mockServer.use(
      http.post(apiUrl("/backups/schedule"), () =>
        fail ? HttpResponse.json({ error: "config locked" }, { status: 500 }) : undefined,
      ),
    );
    const { user } = await renderPage();
    const keep = await screen.findByRole("textbox", { name: "Keep latest" });
    await user.clear(keep);
    await user.type(keep, "30");
    const save = screen.getByRole("button", { name: "Save" });
    await user.click(save);
    const notice = await actionError();
    expect(notice).toHaveTextContent("config locked");
    expect(scheduleCard()).toContainElement(notice);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fail = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(save).toHaveAccessibleName("Saved"));
    noActionError();
    expect(save).toHaveFocus();
    expect(mockDb.schedule.keep).toBe(30);
  });

  it("shows a stored legacy keep above 200 and sends it back unchanged", async () => {
    let body: unknown = null;
    mockServer.use(
      http.get(apiUrl("/backups/schedule"), () =>
        HttpResponse.json({ schedule: { enabled: true, cadence: "daily", keep: 300 } }),
      ),
      http.post(apiUrl("/backups/schedule"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ schedule: body });
      }),
    );
    const { user } = await renderPage();
    const keep = await screen.findByRole("textbox", { name: "Keep latest" });
    expect(keep).toHaveValue("300");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("combobox", { name: "Frequency" }));
    await user.click(await screen.findByRole("option", { name: "Weekly" }));
    await user.click(save);
    await expectAnnounced("The schedule was saved.");
    expect(body).toEqual({ enabled: true, cadence: "weekly", keep: 300 });
  });

  it("shows when the schedule last ran and runs next under the switch", async () => {
    await renderPage();
    const toggle = await screen.findByRole("switch", { name: "Scheduled backup" });
    expect(toggle).toHaveAccessibleDescription(/^(Last run .+|Not run yet) · Next run in .+$/);
  });

  it("asks before leaving the page with an unsaved schedule change", async () => {
    const { user, router } = await renderApp("/backups");
    await user.click(await screen.findByRole("combobox", { name: "Frequency" }));
    await user.click(await screen.findByRole("option", { name: "Weekly" }));
    act(() => {
      void router.navigate({ to: "/settings" });
    });
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Discard unsaved changes?")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
  });
});
