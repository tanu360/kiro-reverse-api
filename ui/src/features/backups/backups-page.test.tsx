import { act, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupEntry } from "@/lib/api/types";
import { getSession, type SessionChangeReason, subscribeSession } from "@/lib/auth/session";
import { saveBlob } from "@/lib/download";
import { formatDateTime } from "@/lib/format";
import { mockDb } from "@/lib/mocks/db";
import { makeBackupEntry } from "@/lib/mocks/fixtures";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { toast } from "@/lib/toast";
import { renderApp, renderWithProviders } from "@/test/render";
import { BackupsPage } from "./backups-page";

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

/** The toast title element, so text elsewhere on the page with the same words never matches. */
async function findToast(text: string): Promise<HTMLElement> {
  const matches = await screen.findAllByText(text);
  const title = matches.find((node) => node.getAttribute("data-slot") === "toast-title");
  if (!title) throw new Error(`no toast titled "${text}"`);
  return title;
}

function dialog(): HTMLElement {
  return screen.getByRole("alertdialog");
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
    expect(within(rows[1]).getByText("Scheduled (Daily)")).toBeInTheDocument();
    expect(within(rows[2]).getByText("7 restored")).toBeInTheDocument();
    expect(
      within(rows[4]).getByText("Before restoring from file kiro-backup-x.json"),
    ).toBeInTheDocument();
  });

  it("shows the empty state when the server sends backups:null", async () => {
    mockServer.use(http.get(apiUrl("/backups"), () => HttpResponse.json({ backups: null })));
    renderWithProviders(<BackupsPage />);
    expect(await screen.findByText("No backups yet")).toBeInTheDocument();
    expect(screen.getByText("Create a backup before you change accounts.")).toBeInTheDocument();
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
    expect(await findToast("Backup created")).toBeInTheDocument();
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
    expect(await findToast("Schedule saved")).toBeInTheDocument();
    expect(body).toEqual({ enabled: true, cadence: "daily", keep: 200 });
  });

  it("marks the Keep field when the server rejects keep, without a toast", async () => {
    mockServer.use(
      http.post(apiUrl("/backups/schedule"), () =>
        HttpResponse.json(
          { error: "keep must be between 1 and 200", code: "invalid_keep" },
          { status: 400 },
        ),
      ),
    );
    const { user } = await renderPage();
    const keep = await screen.findByRole("textbox", { name: "Keep latest" });
    await user.clear(keep);
    await user.type(keep, "30");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a whole number from 1 to 200.")).toBeInTheDocument();
    expect(keep).toHaveAttribute("aria-invalid", "true");
    expect(document.querySelector('[data-slot="toast-title"]')).toBeNull();
    // Editing the value clears the mark.
    await user.type(keep, "1");
    expect(screen.queryByText("Enter a whole number from 1 to 200.")).toBeNull();
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

  it("restores a backup only after confirmation, then toasts and signs out", async () => {
    const restored: string[] = [];
    mockServer.use(
      http.post(apiUrl("/backups/:id/restore"), ({ params }) => {
        restored.push(String(params.id));
        return HttpResponse.json({ success: true });
      }),
    );
    const order: string[] = [];
    vi.spyOn(toast, "success").mockImplementation((title) => {
      order.push(`toast:${title}`);
      return "id";
    });
    const { user } = await renderPage();
    unsubscribe();
    unsubscribe = subscribeSession((_session, reason) => order.push(`session:${reason}`));
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
    expect(order).toEqual([
      "toast:Backup restored. Sign in with the password stored in the backup.",
      "session:restored",
    ]);
    expect(getSession()).toBeNull();
  });

  it("shows a failed restore's server message verbatim and keeps the session", async () => {
    mockServer.use(
      http.post(apiUrl("/backups/:id/restore"), ({ params }) =>
        HttpResponse.json({ error: `backup not found: ${params.id}` }, { status: 500 }),
      ),
    );
    const { user } = await renderPage();
    const [first] = newestFirst();
    await rowAction(user, dataRows()[0], "Restore");
    await user.click(within(dialog()).getByRole("button", { name: "Restore" }));
    expect(await findToast(`backup not found: ${first.id}`)).toBeInTheDocument();
    expect(sessionEvents).toEqual([]);
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
    expect(await findToast("Could not restore from this file")).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "It is not a Kiro Proxy backup. Choose a file you downloaded from Backups. Details: backup content is not valid JSON",
      ).length,
    ).toBeGreaterThan(0);
    expect(sessionEvents).toEqual([]);
    expect(getSession()).not.toBeNull();
  });

  it("maps the wrong-format upload error the same way", async () => {
    const { user } = await renderPage();
    const input = screen.getByTestId("backup-upload-input") as HTMLInputElement;
    await user.upload(input, new File([JSON.stringify({ hello: "world" })], "other.json"));
    await user.click(within(dialog()).getByRole("button", { name: "Restore" }));
    expect(await findToast("Could not restore from this file")).toBeInTheDocument();
    expect(screen.queryByText("unsupported backup format: expected kiro-proxy-backup")).toBeNull();
  });

  it("shows an unknown upload error verbatim", async () => {
    mockServer.use(
      http.post(apiUrl("/backups/restore"), () =>
        HttpResponse.json({ error: "pre-restore snapshot failed: disk full" }, { status: 500 }),
      ),
    );
    const { user } = await renderPage();
    const input = screen.getByTestId("backup-upload-input") as HTMLInputElement;
    await user.upload(input, new File(["{}"], "x.json"));
    await user.click(within(dialog()).getByRole("button", { name: "Restore" }));
    expect(await findToast("pre-restore snapshot failed: disk full")).toBeInTheDocument();
  });

  it("restores from a valid file, then toasts and signs out", async () => {
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
    expect(
      await findToast("Backup restored. Sign in with the password stored in the backup."),
    ).toBeInTheDocument();
    expect(sessionEvents).toEqual(["restored"]);
    const rollback = mockDb.backups.find(
      (row) => row.kind === "pre-restore" && row.restoredAccountCnt === 2,
    );
    expect(rollback?.note).toMatch(/^upload /);
  });

  it("rejects an upload over 32 MiB before sending it", async () => {
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
    Object.defineProperty(file, "size", { value: 32 * 1024 * 1024 + 1 });
    await user.upload(input, file);
    expect(
      await findToast("The file is larger than 32 MiB. Choose a smaller backup file."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(sent).toBe(false);
  });

  it("deletes a backup after confirmation and refetches the list", async () => {
    const { user } = await renderPage();
    const [first] = newestFirst();
    await rowAction(user, dataRows()[0], "Delete");
    expect(within(dialog()).getByText("Delete this backup?")).toBeInTheDocument();
    expect(
      within(dialog()).getByText(
        "The backup file is removed from the server. This cannot be undone.",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    expect(await findToast("Backup deleted")).toBeInTheDocument();
    await waitFor(() => expect(dataRows()).toHaveLength(4));
    expect(mockDb.backups.some((row) => row.id === first.id)).toBe(false);
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
    expect(await findToast("Backup created")).toBeInTheDocument();
    expect(calls).toBe(1);
    expect(screen.getByRole("button", { name: "Create backup" })).toHaveFocus();
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
    expect(await findToast("Backup downloaded")).toBeInTheDocument();
    expect(
      screen.getAllByText("The file contains passwords and tokens in plain text. Store it safely.")
        .length,
    ).toBeGreaterThan(0);
    expect(saveBlob).toHaveBeenCalledTimes(1);
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

  it("moves focus to Create backup in the empty state after deleting the only backup", async () => {
    mockDb.backups.splice(1);
    const { user } = await renderPage();
    await rowAction(user, dataRows()[0], "Delete");
    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("No backups yet")).toBeInTheDocument();
    const create = screen
      .getAllByRole("button", { name: "Create backup" })
      .find((button) => button.hasAttribute("data-empty-focus"));
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

  it("keeps focus on Save after saving instead of remounting the form", async () => {
    const { user } = await renderPage();
    const keep = await screen.findByRole("textbox", { name: "Keep latest" });
    await user.clear(keep);
    await user.type(keep, "30");
    const save = screen.getByRole("button", { name: "Save" });
    await user.click(save);
    expect(await findToast("Schedule saved")).toBeInTheDocument();
    await waitFor(() => expect(save).toHaveAttribute("aria-disabled", "true"));
    expect(save).toBeInTheDocument();
    expect(save).toHaveFocus();
    expect(keep).toHaveValue("30");
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
