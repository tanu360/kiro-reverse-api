import { describe, expect, it } from "vitest";
import type { BackupEntry } from "@/lib/api/types";
import { formatBytes } from "@/lib/format";
import { type Lang, type TParams, translate } from "@/lib/i18n";
import {
  accountsCell,
  backupKind,
  clampKeep,
  isNotABackupMessage,
  keepMax,
  kindLabel,
  kindTone,
  listMeta,
  manualNote,
  messageParts,
  noteText,
  scheduleDirty,
  scheduleForm,
} from "./backup-model";

const tFor = (lang: Lang) => (key: string, params?: TParams) =>
  translate(lang, "backups", key, params);
const t = tFor("en");

function entry(fields: Partial<BackupEntry>): BackupEntry {
  return {
    id: "20261103-101500-123456789-ab12cd34",
    createdAt: 1_793_700_900,
    kind: "manual",
    file: "x.json",
    size: 1000,
    sha256: "0".repeat(64),
    ...fields,
  };
}

describe("manualNote", () => {
  it("formats local time zero-padded", () => {
    expect(manualNote(new Date(2026, 10, 3, 9, 5, 7))).toBe("manual backup 2026-11-03 09:05:07");
  });
});

describe("noteText", () => {
  it("describes a rollback point taken before an upload", () => {
    expect(noteText(entry({ kind: "pre-restore", note: "upload kiro-backup-x.json" }), t)).toBe(
      "Before restoring from file kiro-backup-x.json",
    );
  });

  it("describes a rollback point taken before a restore by id", () => {
    expect(noteText(entry({ kind: "pre-restore", note: "auto before restore abc-123" }), t)).toBe(
      "Before restoring backup abc-123",
    );
  });

  it("describes the backup a duplicate merge saves first", () => {
    const merge = entry({ kind: "auto", note: "before merging duplicate accounts" });
    expect(noteText(merge, t)).toBe("Before merging duplicate accounts");
    expect(noteText(merge, tFor("zh"))).toBe("合并重复账号之前");
  });

  it("labels the server note of a scheduled backup", () => {
    expect(noteText(entry({ kind: "scheduled", note: "auto-daily" }), t)).toBe("Scheduled (Daily)");
    expect(noteText(entry({ kind: "scheduled", note: "auto-weekly" }), tFor("zh"))).toBe(
      "定时（每周）",
    );
  });

  it("shows a plain note through the mask", () => {
    const mask = (text?: string) => (text ?? "").replace("ann@example.com", "an***@ex***.com");
    expect(noteText(entry({ note: "before moving ann@example.com" }), t, mask)).toBe(
      "before moving an***@ex***.com",
    );
    expect(noteText(entry({ kind: "scheduled", note: "auto-monthly" }), t)).toBe("auto-monthly");
  });

  it("masks the file name inside a rollback-point note", () => {
    const mask = (text?: string) => (text ?? "").replace("ann@example.com", "an***");
    expect(
      noteText(entry({ kind: "pre-restore", note: "upload ann@example.com.json" }), t, mask),
    ).toBe("Before restoring from file an***.json");
  });

  it("shows an em dash for an empty note", () => {
    expect(noteText(entry({ note: undefined }), t)).toBe("—");
    expect(noteText(entry({ note: "   " }), t)).toBe("—");
  });
});

describe("kindLabel and kindTone", () => {
  it("labels every server kind", () => {
    expect(kindLabel("manual", t)).toBe("Manual");
    expect(kindLabel("scheduled", t)).toBe("Scheduled");
    expect(kindLabel("auto", t)).toBe("Before save");
    expect(kindLabel("pre-restore", t)).toBe("Rollback point");
  });

  it("gives the backup a duplicate merge saves first its own kind, old rows too", () => {
    const merge = entry({ kind: "auto", note: "before merging duplicate accounts" });
    expect(backupKind(merge)).toBe("pre-merge");
    expect(kindLabel(backupKind(merge), t)).toBe("Before merge");
    expect(kindLabel(backupKind(merge), tFor("zh"))).toBe("合并前");
    expect(kindTone(backupKind(merge))).toBe("neutral");
    // Any other automatic backup, and a manual one with that note, keep the server's kind.
    expect(backupKind(entry({ kind: "auto", note: "" }))).toBe("auto");
    expect(backupKind(entry({ kind: "auto" }))).toBe("auto");
    expect(backupKind(entry({ kind: "manual", note: "before merging duplicate accounts" }))).toBe(
      "manual",
    );
  });

  it("shows an unknown kind raw, and an em dash when empty", () => {
    expect(kindLabel("nightly-import", t)).toBe("nightly-import");
    expect(kindLabel("", t)).toBe("—");
  });

  it("marks manual backups, warns on rollback points and keeps the rest neutral", () => {
    expect(kindTone("manual")).toBe("primary");
    expect(kindTone("pre-restore")).toBe("warning");
    for (const kind of ["scheduled", "auto", "nightly-import"]) {
      expect(kindTone(kind)).toBe("neutral");
    }
  });
});

describe("accountsCell", () => {
  it("shows restored accounts with the saved count as hint on a rollback point", () => {
    expect(
      accountsCell(entry({ kind: "pre-restore", accountCnt: 7, restoredAccountCnt: 6 }), t),
    ).toEqual({
      text: "6 restored",
      hint: "Rollback point saved 7 accounts before the restore.",
    });
    expect(
      accountsCell(entry({ kind: "pre-restore", accountCnt: 1, restoredAccountCnt: 0 }), t).hint,
    ).toBe("Rollback point saved 1 account before the restore.");
  });

  it("shows the account count otherwise, grouped, and a dash when omitted", () => {
    expect(accountsCell(entry({ accountCnt: 8 }), t)).toEqual({ text: "8" });
    expect(accountsCell(entry({ accountCnt: 9400 }), t, "en")).toEqual({ text: "9,400" });
    expect(accountsCell(entry({ accountCnt: 9400 }), t, "pt-BR")).toEqual({ text: "9.400" });
    expect(accountsCell(entry({ accountCnt: 0 }), t)).toEqual({ text: "0" });
    expect(accountsCell(entry({ accountCnt: undefined }), t)).toEqual({ text: "—" });
    expect(accountsCell(entry({ kind: "pre-restore", accountCnt: 3 }), t)).toEqual({ text: "3" });
  });

  it("groups the restored and saved counts of a rollback point", () => {
    expect(
      accountsCell(
        entry({ kind: "pre-restore", accountCnt: 9400, restoredAccountCnt: 1200 }),
        t,
        "en",
      ),
    ).toEqual({
      text: "1,200 restored",
      hint: "Rollback point saved 9,400 accounts before the restore.",
    });
  });
});

describe("clampKeep", () => {
  it("clamps to 1..200 and keeps the stored value for anything not a number", () => {
    expect(clampKeep(0)).toBe(1);
    expect(clampKeep(500)).toBe(200);
    expect(clampKeep(Number.NaN)).toBe(50);
    expect(clampKeep(Number.NaN, 14)).toBe(14);
    expect(clampKeep(14)).toBe(14);
    expect(clampKeep(7.6)).toBe(8);
  });

  it("sends a stored legacy keep above 200 back unchanged, and clamps any other", () => {
    expect(clampKeep(300, 300)).toBe(300);
    expect(clampKeep(299, 300)).toBe(200);
    expect(clampKeep(500, 300)).toBe(200);
  });
});

describe("keepMax", () => {
  it("is 200, or a larger stored keep", () => {
    expect(keepMax(50)).toBe(200);
    expect(keepMax(300)).toBe(300);
  });
});

describe("scheduleForm", () => {
  it("reads an unset keep as the server's 50", () => {
    expect(scheduleForm({})).toEqual({ enabled: false, cadence: "daily", keep: 50 });
    expect(scheduleForm({ enabled: true, cadence: "weekly", keep: 5, lastRun: 1 })).toEqual({
      enabled: true,
      cadence: "weekly",
      keep: 5,
    });
  });

  it("shows the server's keep as is, a legacy value above 200 included", () => {
    expect(scheduleForm({ keep: 300 }).keep).toBe(300);
  });
});

describe("messageParts", () => {
  it("splits a message around one placeholder, keeping its spacing", () => {
    expect(messageParts(t, "lastRun", "time")).toEqual(["Last run ", ""]);
    expect(messageParts(t, "nextRun", "time")).toEqual(["Next run ", ""]);
    expect(messageParts(tFor("zh"), "lastRun", "time")).toEqual(["上次运行：", ""]);
    expect(messageParts(t, "confirmRestore", "time")).toEqual(["Restore the backup from ", "?"]);
  });
});

describe("listMeta", () => {
  it("counts the backups and adds up their size", () => {
    const rows = [entry({ size: 1024 }), entry({ size: 1024 })];
    expect(listMeta(rows, t, "en")).toBe(`2 backups · ${formatBytes(2048, "en")}`);
    expect(listMeta([entry({ size: 512 })], t, "en")).toBe(`1 backup · ${formatBytes(512, "en")}`);
    expect(listMeta([], t, "en")).toBe(`0 backups · ${formatBytes(0, "en")}`);
  });
});

describe("isNotABackupMessage", () => {
  it("matches the server's parse and format errors for an uploaded file", () => {
    expect(isNotABackupMessage("backup content is not valid JSON")).toBe(true);
    expect(isNotABackupMessage("unsupported backup format: expected kiro-proxy-backup")).toBe(true);
    expect(isNotABackupMessage("unsupported backup version: 7")).toBe(true);
    expect(isNotABackupMessage("backup schema mismatch: missing password")).toBe(true);
    expect(isNotABackupMessage(" backup JSON parse failed: unexpected end ")).toBe(true);
    expect(isNotABackupMessage("credential 2 missing id")).toBe(true);
  });

  it("leaves other failures alone", () => {
    expect(isNotABackupMessage("pre-restore snapshot failed: disk full")).toBe(false);
    expect(isNotABackupMessage("backup not found: abc")).toBe(false);
    expect(isNotABackupMessage("")).toBe(false);
  });
});

describe("scheduleDirty", () => {
  const initial = { enabled: true, cadence: "daily" as const, keep: 14 };

  it("is clean when nothing would change", () => {
    expect(scheduleDirty(initial, { ...initial })).toBe(false);
    // 14.2 is saved as 14.
    expect(scheduleDirty(initial, { ...initial, keep: 14.2 })).toBe(false);
  });

  it("is dirty for any change, and for an emptied keep field", () => {
    expect(scheduleDirty(initial, { ...initial, enabled: false })).toBe(true);
    expect(scheduleDirty(initial, { ...initial, cadence: "weekly" })).toBe(true);
    expect(scheduleDirty(initial, { ...initial, keep: 15 })).toBe(true);
    expect(scheduleDirty(initial, { ...initial, keep: null })).toBe(true);
  });

  it("keeps a legacy keep above 200 clean while it is unchanged", () => {
    const legacy = { ...initial, keep: 300 };
    expect(scheduleDirty(legacy, { ...legacy })).toBe(false);
    expect(scheduleDirty(legacy, { ...legacy, keep: 299 })).toBe(true);
  });
});
