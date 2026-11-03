import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommand = document.execCommand;

function setClipboard(value: Partial<Clipboard> | undefined): void {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

function setExecCommand(impl: (command: string) => boolean): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  document.execCommand = fn as unknown as typeof document.execCommand;
  return fn;
}

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  document.execCommand = originalExecCommand;
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("falls back to execCommand('copy') when navigator.clipboard is missing", async () => {
    setClipboard(undefined);
    let copied = "";
    const exec = setExecCommand(() => {
      copied = document.querySelector("textarea")?.value ?? "";
      return true;
    });
    await expect(copyText("secret")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(copied).toBe("secret");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("returns false when every strategy fails", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    setExecCommand(() => {
      throw new Error("not allowed");
    });
    await expect(copyText("secret")).resolves.toBe(false);
  });

  it("returns false when the value promise rejects", async () => {
    setClipboard(undefined);
    setExecCommand(() => true);
    await expect(copyText(Promise.reject(new Error("fetch failed")))).resolves.toBe(false);
  });

  it("uses writeText for a plain string", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await expect(copyText("abc")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("abc");
  });

  it("hands a promise to ClipboardItem so Safari keeps the user activation", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn();
    setClipboard({ write, writeText });
    class FakeClipboardItem {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    }
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    await expect(copyText(Promise.resolve("later"))).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const [item] = write.mock.calls[0][0] as FakeClipboardItem[];
    expect(await item.items["text/plain"].then((blob) => blob.text())).toBe("later");
    expect(writeText).not.toHaveBeenCalled();
  });
});
