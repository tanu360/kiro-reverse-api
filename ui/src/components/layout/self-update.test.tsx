import { describe, expect, it, vi } from "vitest";
import { type SelfUpdate, updateButtonAction } from "./self-update";

const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key;

function update(over: Partial<SelfUpdate>): SelfUpdate {
  return {
    status: { state: "idle", supported: true },
    available: true,
    target: "3.6.0",
    phase: "idle",
    start: vi.fn(),
    restart: vi.fn(),
    confirmRestart: vi.fn(),
    ...over,
  };
}

describe("updateButtonAction", () => {
  it("downloads while a release waits, and retries after a failure", () => {
    const idle = update({});
    expect(updateButtonAction(idle, t)).toEqual({
      label: "shell.update.download",
      run: idle.start,
    });
    const failed = update({ phase: "error" });
    expect(updateButtonAction(failed, t)).toEqual({
      label: "shell.update.retry",
      run: failed.start,
    });
  });

  it("asks before it restarts once the release is in place", () => {
    const ready = update({ phase: "ready" });
    expect(updateButtonAction(ready, t)).toEqual({
      label: "shell.update.restart",
      run: ready.confirmRestart,
    });
  });

  it("does nothing while it downloads or restarts, and says how far it got", () => {
    const downloading = update({
      phase: "downloading",
      status: { state: "downloading", supported: true, progress: 45 },
    });
    expect(updateButtonAction(downloading, t)).toEqual({
      label: 'shell.update.statusDownloading {"percent":45}',
    });
    expect(updateButtonAction(update({ phase: "restarting" }), t).run).toBeUndefined();
  });
});
