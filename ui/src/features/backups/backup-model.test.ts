import { describe, expect, it } from "vitest";
import type { BackupEntry } from "@/lib/api/types";
import { type Lang, type TParams, translate } from "@/lib/i18n";
import {
  accountsCell,
  clampKeep,
  isNotABackupMessage,
  keepSentenceParts,
  kindLabel,
  kindTone,
  manualNote,
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

  it("shows an unknown kind raw, and an em dash when empty", () => {
    expect(kindLabel("nightly-import", t)).toBe("nightly-import");
    expect(kindLabel("", t)).toBe("—");
  });

  it("uses the warning tone only for rollback points", () => {
    expect(kindTone("pre-restore")).toBe("warning");
    for (const kind of ["manual", "scheduled", "auto", "nightly-import"]) {
      expect(kindTone(kind)).toBe("info");
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

  it("shows the account count otherwise, 0 when omitted", () => {
    expect(accountsCell(entry({ accountCnt: 8 }), t)).toEqual({ text: "8" });
    expect(accountsCell(entry({ accountCnt: undefined }), t)).toEqual({ text: "0" });
    expect(accountsCell(entry({ kind: "pre-restore", accountCnt: 3 }), t)).toEqual({ text: "3" });
  });
});

describe("clampKeep", () => {
  it("clamps to 1..200 and defaults to 20", () => {
    expect(clampKeep(0)).toBe(1);
    expect(clampKeep(500)).toBe(200);
    expect(clampKeep(Number.NaN)).toBe(20);
    expect(clampKeep(14)).toBe(14);
    expect(clampKeep(7.6)).toBe(8);
  });
});

describe("scheduleForm", () => {
  it("fills the old UI defaults for an unconfigured schedule", () => {
    expect(scheduleForm({})).toEqual({ enabled: false, cadence: "daily", keep: 20 });
    expect(scheduleForm({ enabled: true, cadence: "weekly", keep: 5, lastRun: 1 })).toEqual({
      enabled: true,
      cadence: "weekly",
      keep: 5,
    });
  });
});

describe("keepSentenceParts", () => {
  it("splits the keep message around the count", () => {
    expect(keepSentenceParts(t, "en", 20)).toEqual(["Keep latest", "backups"]);
    expect(keepSentenceParts(t, "en", 1)).toEqual(["Keep latest", "backup"]);
    expect(keepSentenceParts(tFor("zh"), "zh", 1)).toEqual(["保留最新", "份备份"]);
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
});
