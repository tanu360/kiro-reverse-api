import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VersionResponse } from "@/lib/api/types";
import { copyText } from "@/lib/clipboard";
import { renderWithProviders } from "@/test/render";
import {
  binaryCommand,
  capitalizeFirst,
  parseChangelog,
  preferredMethod,
  releaseArchive,
  splitChangelog,
  UpdateDialog,
} from "./update-dialog";
import { GITHUB_URL } from "./user-menu";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));

const copyTextMock = vi.mocked(copyText);

beforeEach(() => {
  copyTextMock.mockReset();
});

const RELEASES = "https://github.com/tanu360/kiro-reverse-api/releases/latest";
const CHANGELOG = [
  "🔑 New keys for every client",
  "- 📦 Release binaries for six platforms",
  "🔧 Fixed: max_tokens now cuts the answer on every API",
  "🔧 Fixed: the duplicate accounts dialog explains each step",
].join("\n");
const LINUX: VersionResponse = { version: "2.1.0", os: "linux", arch: "amd64", docker: false };

function renderDialog({
  changelog = CHANGELOG,
  download = RELEASES,
  server = LINUX,
}: {
  changelog?: string;
  download?: string;
  server?: VersionResponse;
} = {}) {
  return renderWithProviders(
    <UpdateDialog
      current="2.1.0"
      latest={{ version: "v2.2.0", changelog, download }}
      onOpenChange={() => {}}
      open
      server={server}
    />,
  );
}

describe("parseChangelog", () => {
  it("takes the emoji as the marker, drops bullets and sets a tag apart", () => {
    const lines = parseChangelog("- 🎨 New: a panel\n\n* plain line\n🛠️ Fixed: restores");
    expect(lines.map(({ marker, tag, text }) => ({ marker, tag, text }))).toEqual([
      { marker: "🎨", tag: "New:", text: "a panel" },
      { marker: null, tag: null, text: "plain line" },
      { marker: "🛠️", tag: "Fixed:", text: "restores" },
    ]);
  });

  it("numbers a repeated line's key, so each list item stays unique", () => {
    const keys = parseChangelog("🔧 Same\n🔧 Same").map((line) => line.key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("splitChangelog", () => {
  it("files Fixed: and Fix: lines under fixes, without the tag and capitalised", () => {
    const { news, fixes } = splitChangelog(
      "🔑 New: keys\n🔧 Fixed: the toast\n🔧 fix: a crash\n⚙️ Changed: defaults",
    );
    expect(news.map((line) => [line.tag, line.text])).toEqual([
      ["New:", "keys"],
      ["Changed:", "defaults"],
    ]);
    expect(fixes.map((line) => [line.marker, line.tag, line.text])).toEqual([
      ["🔧", null, "The toast"],
      ["🔧", null, "A crash"],
    ]);
  });

  it("gives empty lists for a missing or blank changelog", () => {
    expect(splitChangelog(undefined)).toEqual({ news: [], fixes: [] });
    expect(splitChangelog("  \n ")).toEqual({ news: [], fixes: [] });
  });
});

describe("capitalizeFirst", () => {
  it("capitalises a plain word and leaves names and code alone", () => {
    expect(capitalizeFirst("the outbound proxy dialog")).toBe("The outbound proxy dialog");
    expect(capitalizeFirst("a streamed answer")).toBe("A streamed answer");
    expect(capitalizeFirst("self-heal, at last")).toBe("Self-heal, at last");
    expect(capitalizeFirst("max_tokens, stop sequences")).toBe("max_tokens, stop sequences");
    expect(capitalizeFirst("deepseek-3.2 no longer")).toBe("deepseek-3.2 no longer");
    expect(capitalizeFirst("budget_tokens and effort")).toBe("budget_tokens and effort");
    expect(capitalizeFirst("GET /v1/models/{id} works")).toBe("GET /v1/models/{id} works");
    expect(capitalizeFirst("")).toBe("");
  });
});

describe("release archive", () => {
  it("names the archive for the server's platform, as build-release.sh does", () => {
    const arm = releaseArchive({ os: "linux", arch: "arm64" });
    expect(arm).toMatchObject({
      file: "kiro-proxy-linux-arm64.tar.gz",
      folder: "kiro-proxy-linux-arm64",
      windows: false,
      platformLabel: "shell.update.platformLinuxArm64",
      known: true,
    });
    expect(binaryCommand(arm)).toBe(
      "curl -fLO https://github.com/tanu360/kiro-reverse-api/releases/latest/download/kiro-proxy-linux-arm64.tar.gz && tar -xzf kiro-proxy-linux-arm64.tar.gz",
    );
    expect(releaseArchive({ os: "darwin", arch: "arm64" })).toMatchObject({
      file: "kiro-proxy-macos-apple-silicon.tar.gz",
      platformLabel: "shell.update.platformMacosAppleSilicon",
    });
    expect(releaseArchive({ os: "darwin", arch: "amd64" }).file).toBe(
      "kiro-proxy-macos-intel.tar.gz",
    );
    expect(releaseArchive({ os: "linux", arch: "amd64" })).toMatchObject({
      file: "kiro-proxy-linux-x64.tar.gz",
      platformLabel: "shell.update.platformLinuxX64",
    });
  });

  it("gives Windows the zip and a PowerShell command", () => {
    const win = releaseArchive({ os: "windows", arch: "amd64" });
    expect(win).toMatchObject({ file: "kiro-proxy-windows-x64.zip", windows: true });
    expect(binaryCommand(win)).toBe(
      "curl.exe -fLO https://github.com/tanu360/kiro-reverse-api/releases/latest/download/kiro-proxy-windows-x64.zip; Expand-Archive -Force kiro-proxy-windows-x64.zip .",
    );
  });

  it("falls back to linux-x64 for a platform with no archive, or none reported", () => {
    for (const server of [{ os: "freebsd", arch: "amd64" }, { os: "linux", arch: "386" }, {}]) {
      expect(releaseArchive(server)).toMatchObject({
        file: "kiro-proxy-linux-x64.tar.gz",
        known: false,
      });
    }
  });
});

describe("preferredMethod", () => {
  it("opens Compose in a container, the binary outside one, Compose when unknown", () => {
    expect(preferredMethod({ ...LINUX, docker: true })).toBe("compose");
    expect(preferredMethod(LINUX)).toBe("binary");
    expect(preferredMethod({ version: "2.1.0" })).toBe("compose");
    expect(preferredMethod(undefined)).toBe("compose");
  });
});

describe("UpdateDialog", () => {
  it("shows the version change beside the title", async () => {
    renderDialog();
    expect(
      await screen.findByRole("heading", { name: "Version update 2.1.0 to 2.2.0" }),
    ).toBeInTheDocument();
  });

  it("splits the changelog into New and Fixes, each with its count", async () => {
    const { user } = renderDialog();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["New2", "Fixes2", "How to update"]);
    expect(screen.getByRole("tab", { name: /^New/ })).toHaveAttribute("aria-selected", "true");
    const news = screen.getByRole("tabpanel", { name: /^New/ });
    expect(
      within(news)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["🔑New keys for every client", "📦Release binaries for six platforms"]);

    await user.click(screen.getByRole("tab", { name: /Fixes/ }));
    const fixes = await screen.findByRole("tabpanel", { name: /Fixes/ });
    expect(
      within(fixes)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "🔧max_tokens now cuts the answer on every API",
      "🔧The duplicate accounts dialog explains each step",
    ]);
    expect(within(fixes).queryByText(/Fixed:/)).toBeNull();
  });

  it("moves between tabs with the arrow keys", async () => {
    const { user } = renderDialog();
    const first = await screen.findByRole("tab", { name: /^New/ });
    first.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /Fixes/ })).toHaveFocus();
    await user.keyboard("{ArrowRight}{Enter}");
    expect(screen.getByRole("tab", { name: "How to update" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("leaves out Fixes when no line is a fix, and New when every line is", async () => {
    const { unmount } = renderDialog({ changelog: "🔑 New keys\n📦 Binaries" });
    expect((await screen.findAllByRole("tab")).map((tab) => tab.textContent)).toEqual([
      "New2",
      "How to update",
    ]);
    unmount();

    renderDialog({ changelog: "🔧 Fixed: a crash" });
    expect((await screen.findAllByRole("tab")).map((tab) => tab.textContent)).toEqual([
      "Fixes1",
      "How to update",
    ]);
    expect(screen.getByRole("tab", { name: /Fixes/ })).toHaveAttribute("aria-selected", "true");
  });

  it("shows only How to update, without a tab strip, when there is no changelog", async () => {
    renderDialog({ changelog: "" });
    expect(await screen.findByRole("radiogroup", { name: "Update method" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("opens on the binary for a server outside a container, with its own archive", async () => {
    const { user } = renderDialog({
      changelog: "",
      server: { version: "2.1.0", os: "darwin", arch: "arm64", docker: false },
    });
    expect(await screen.findByRole("radio", { name: "Binary" })).toBeChecked();
    expect(screen.getByText(/download the macOS \(Apple silicon\) build/)).toBeInTheDocument();
    const box = screen.getByRole("textbox", { name: /^Stop the proxy/ });
    expect(box).toHaveTextContent(
      "curl -fLO https://github.com/tanu360/kiro-reverse-api/releases/latest/download/kiro-proxy-macos-apple-silicon.tar.gz && tar -xzf kiro-proxy-macos-apple-silicon.tar.gz",
    );
    expect(
      screen.getByText("kiro-proxy-macos-apple-silicon", { selector: "code" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("DATA_DIR", { selector: "code" })).toHaveLength(2);

    copyTextMock.mockResolvedValue(true);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await copyTextMock.mock.calls[0]?.[0]).toBe(box.textContent);
  });

  it("opens on Docker Compose in a container, and every method stays reachable", async () => {
    const { user } = renderDialog({ changelog: "", server: { ...LINUX, docker: true } });
    expect(await screen.findByRole("radio", { name: "Docker Compose" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: /^In your clone/ })).toHaveTextContent(
      "git pull && docker compose up -d --build",
    );

    await user.click(screen.getByRole("radio", { name: "Docker image" }));
    expect(screen.getByRole("textbox", { name: "Pull the new image:" })).toHaveTextContent(
      "docker pull ghcr.io/tanu360/kiro-reverse-api:latest",
    );
    expect(screen.getByText(/recreate the container with the same volume/)).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Binary" }));
    expect(screen.getByRole("textbox", { name: /^Stop the proxy/ })).toHaveTextContent(
      "kiro-proxy-linux-x64.tar.gz",
    );
  });

  it("names PowerShell and the zip for a Windows server", async () => {
    renderDialog({
      changelog: "",
      server: { version: "2.1.0", os: "windows", arch: "arm64", docker: false },
    });
    expect(await screen.findByRole("textbox", { name: /In PowerShell/ })).toHaveTextContent(
      "Expand-Archive -Force kiro-proxy-windows-arm64.zip .",
    );
  });

  it("points at the linux-x64 archive and says how to pick another when the platform is unknown", async () => {
    renderDialog({ changelog: "", server: { version: "2.1.0", os: "freebsd", arch: "amd64" } });
    await screen.findByRole("radio", { name: "Binary", checked: true });
    expect(screen.getByText(/For another platform, use its archive/)).toBeInTheDocument();
  });

  it("opens the remote file's https link, the latest release page", async () => {
    renderDialog();
    expect(await screen.findByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
      "href",
      RELEASES,
    );
  });

  it("opens the repository when the remote file has no https link", async () => {
    renderDialog({ download: "javascript:alert(1)" });
    expect(await screen.findByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
      "href",
      GITHUB_URL,
    );
  });
});
