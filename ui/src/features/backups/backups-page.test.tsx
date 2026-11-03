import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupEntry } from "@/lib/api/types";
import { getSession, type SessionChangeReason, subscribeSession } from "@/lib/auth/session";
import { saveBlob } from "@/lib/download";
import { mockDb } from "@/lib/mocks/db";
import { makeBackupEntry } from "@/lib/mocks/fixtures";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { toast } from "@/lib/toast";
import { renderWithProviders } from "@/test/render";
import { BackupsPage } from "./backups-page";

vi.mock("@/lib/download", () => ({ saveBlob: vi.fn(), saveJson: vi.fn() }));

const sessionEvents: SessionChangeReason[] = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  sessionEvents.length = 0;
});

afterEach(() => {
  unsubscribe();
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

/** Renders the page, waits for the rows, then records session changes from here on. */
async function renderPage() {
  const view = renderWithProviders(<BackupsPage />);
  await screen.findAllByRole("button", { name: "Download" });
  unsubscribe = subscribeSession((_session, reason) => sessionEvents.push(reason));
  return view;
}

/** The toast title; a live region may repeat the text, so the toast itself is picked. */
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
    expect(rows).toHaveLength(6);
    const kinds = rows.map((row) => row.querySelector('[data-slot="badge"]')?.textContent);
    expect(kinds).toEqual([
      "Manual",
      "Before save",
      "Scheduled",
      "Rollback point",
      "Scheduled",
      "Rollback point",
    ]);
    const rollback = within(rows[3]).getByText("Rollback point");
    expect(rollback).toHaveAttribute("data-tone", "warning");
    expect(within(rows[1]).getByText("Before save")).toHaveAttribute("data-tone", "info");
    expect(within(rows[2]).getByText("Scheduled (Daily)")).toBeInTheDocument();
    expect(within(rows[3]).getByText("7 restored")).toBeInTheDocument();
    expect(
      within(rows[5]).getByText("Before restoring from file kiro-backup-x.json"),
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
    const keep = await screen.findByRole("textbox", {
      name: "Number of scheduled backups to keep",
    });
    expect(keep).toHaveValue("14");
    await user.clear(keep);
    await user.type(keep, "500");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await findToast("Schedule saved")).toBeInTheDocument();
    expect(body).toEqual({ enabled: true, cadence: "daily", keep: 200 });
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
    const restoreButton = () => within(dataRows()[0]).getByRole("button", { name: "Restore" });

    await user.click(restoreButton());
    expect(within(dialog()).getByText("Restore this backup?")).toBeInTheDocument();
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(restored).toEqual([]);
    expect(getSession()).not.toBeNull();

    await user.click(restoreButton());
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
    await user.click(within(dataRows()[0]).getByRole("button", { name: "Restore" }));
    await user.click(within(dialog()).getByRole("button", { name: "Restore" }));
    expect(await findToast(`backup not found: ${first.id}`)).toBeInTheDocument();
    expect(sessionEvents).toEqual([]);
  });

  it("shows an upload's server error verbatim, keeps the session and resets the input", async () => {
    const { user } = await renderPage();
    const input = screen.getByTestId("backup-upload-input") as HTMLInputElement;
    const file = new File(["not json at all"], "broken.json", { type: "application/json" });
    await user.upload(input, file);
    expect(input.value).toBe("");
    expect(within(dialog()).getByText("Restore from this file?")).toBeInTheDocument();
    await user.click(within(dialog()).getByRole("button", { name: "Restore" }));
    expect(await findToast("backup content is not valid JSON")).toBeInTheDocument();
    expect(sessionEvents).toEqual([]);
    expect(getSession()).not.toBeNull();
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
    await user.click(within(dataRows()[0]).getByRole("button", { name: "Delete" }));
    expect(within(dialog()).getByText("Delete this backup?")).toBeInTheDocument();
    expect(within(dialog()).getByText("This cannot be undone.")).toBeInTheDocument();
    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    expect(await findToast("Backup deleted")).toBeInTheDocument();
    await waitFor(() => expect(dataRows()).toHaveLength(5));
    expect(mockDb.backups.some((row) => row.id === first.id)).toBe(false);
  });
});
