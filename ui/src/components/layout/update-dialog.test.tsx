import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VersionResponse } from "@/lib/api/types";
import { copyText } from "@/lib/clipboard";
import { renderWithProviders } from "@/test/render";
import type { SelfUpdate } from "./self-update";
import {
  binaryCommand,
  capitalizeFirst,
  parseChangelog,
  plainChangelog,
  preferredMethod,
  releaseArchive,
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

describe("plainChangelog", () => {
  it("keeps the changelog's order and drops every kind tag, capitalising what follows", () => {
    const lines = plainChangelog(
      "🔑 New: keys\n🔧 Fixed: the tooltip\n🔧 fix: a crash\n⚙️ Changed: defaults\n📦 Binaries",
    );
    expect(lines.map((line) => [line.marker, line.tag, line.text])).toEqual([
      ["🔑", null, "Keys"],
      ["🔧", null, "The tooltip"],
      ["🔧", null, "A crash"],
      ["⚙️", null, "Defaults"],
      ["📦", null, "Binaries"],
    ]);
  });

  it("gives an empty list for a missing or blank changelog", () => {
    expect(plainChangelog(undefined)).toEqual([]);
    expect(plainChangelog("  \n ")).toEqual([]);
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

/** Makes `useMediaQuery("max-sm")` match, as on a phone, until the test ends. */
function asPhone() {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query === "(max-width: 639px)",
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

function listTexts(list: HTMLElement): (string | null)[] {
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent);
}

describe("UpdateDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the version change beside the title", async () => {
    renderDialog();
    expect(
      await screen.findByRole("heading", { name: "Version update 2.1.0 to 2.2.0" }),
    ).toBeInTheDocument();
  });

  it("lists the first changes as they come, without kinds, and links to all of them", async () => {
    renderDialog({
      changelog: [
        "🔑 New keys for every client",
        "🔧 Fixed: max_tokens now cuts the answer on every API",
        "📦 Release binaries for six platforms",
        "🔧 Fixed: the duplicate accounts dialog explains each step",
        "🧭 Request details list every attempt",
        "🔔 Alerts by webhook",
      ].join("\n"),
    });
    const list = await screen.findByRole("list", { name: "What's new" });
    expect(listTexts(list)).toEqual([
      "🔑New keys for every client",
      "🔧max_tokens now cuts the answer on every API",
      "📦Release binaries for six platforms",
    ]);
    expect(within(list).queryByText(/Fixed:/)).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Changes to show" })).toBeNull();
    expect(screen.getByRole("link", { name: /See all 6 changes on GitHub/ })).toHaveAttribute(
      "href",
      RELEASES,
    );
  });

  it("links to the release when every change fits", async () => {
    renderDialog({ changelog: "🔑 New keys\n🔧 Fixed: a crash" });
    expect(await screen.findByRole("link", { name: /View the release on GitHub/ })).toHaveAttribute(
      "href",
      RELEASES,
    );
  });

  it("puts How to update right under the changes, with no tabs", async () => {
    renderDialog();
    expect(await screen.findByRole("heading", { name: "What's new" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "How to update" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Update method" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("shows only How to update when there is no changelog", async () => {
    renderDialog({ changelog: "" });
    expect(await screen.findByRole("radiogroup", { name: "Update method" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "What's new" })).toBeNull();
  });

  it("keeps the same simple page on a phone", async () => {
    asPhone();
    renderDialog();
    expect(await screen.findByRole("list", { name: "What's new" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Update method" })).toBeInTheDocument();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("opens on the binary for a server outside a container, with its own archive", async () => {
    const { user } = renderDialog({
      changelog: "",
      server: { version: "2.1.0", os: "darwin", arch: "arm64", docker: false },
    });
    const binary = await screen.findByRole("radio", { name: /^Binary/ });
    expect(binary).toBeChecked();
    expect(binary).toHaveAccessibleName(/Recommended/);
    expect(screen.getByText(/download the macOS \(Apple silicon\) build/)).toBeInTheDocument();
    const box = screen.getByRole("textbox", { name: /^In the folder that holds/ });
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

  it("offers only the Docker ways in a container, Compose first", async () => {
    const { user } = renderDialog({ changelog: "", server: { ...LINUX, docker: true } });
    expect(await screen.findByRole("radio", { name: /^Docker Compose/ })).toBeChecked();
    expect(screen.queryByRole("radio", { name: /^Binary/ })).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Pull the new code and rebuild the container:" }),
    ).toHaveTextContent("git pull && docker compose up -d --build");
    expect(screen.getByText("Reload this page. The sidebar shows 2.2.0.")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /^Docker image/ }));
    expect(screen.getByRole("textbox", { name: "Pull the new image:" })).toHaveTextContent(
      "docker pull ghcr.io/tanu360/kiro-reverse-api:latest",
    );
    expect(screen.getByText(/Recreate the container with the same volume/)).toBeInTheDocument();
  });

  it("shows the changes and only the Docker steps in a container", async () => {
    renderDialog({ server: { ...LINUX, docker: true } });
    expect(await screen.findByRole("list", { name: "What's new" })).toBeInTheDocument();
    const methods = screen.getByRole("radiogroup", { name: "Update method" });
    expect(within(methods).getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("keeps every way reachable for a binary that updates by hand", async () => {
    const { user } = renderDialog({ changelog: "" });
    expect(await screen.findByRole("radio", { name: /^Binary/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /^Docker Compose/ }));
    expect(
      screen.getByRole("textbox", { name: "Pull the new code and rebuild the container:" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /^Binary/ }));
    expect(screen.getByRole("textbox", { name: /^In the folder that holds/ })).toHaveTextContent(
      "kiro-proxy-linux-x64.tar.gz",
    );
  });

  it("recommends nothing when the server did not say what it runs on", async () => {
    renderDialog({ changelog: "", server: { version: "2.1.0" } });
    expect(await screen.findByRole("radio", { name: /^Docker Compose/ })).toBeChecked();
    expect(screen.queryByText("Recommended")).toBeNull();
  });

  it("names PowerShell and the zip for a Windows server", async () => {
    renderDialog({
      changelog: "",
      server: { version: "2.1.0", os: "windows", arch: "arm64", docker: false },
    });
    expect(await screen.findByRole("textbox", { name: /^In PowerShell/ })).toHaveTextContent(
      "Expand-Archive -Force kiro-proxy-windows-arm64.zip .",
    );
  });

  it("points at the linux-x64 archive and says how to pick another when the platform is unknown", async () => {
    renderDialog({ changelog: "", server: { version: "2.1.0", os: "freebsd", arch: "amd64" } });
    await screen.findByRole("radio", { name: /^Binary/, checked: true });
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

function selfUpdate(over: Partial<SelfUpdate> = {}): SelfUpdate {
  return {
    status: { state: "idle", supported: true },
    available: true,
    target: "2.2.0",
    phase: "idle",
    start: vi.fn(),
    restart: vi.fn(),
    confirmRestart: vi.fn(),
    ...over,
  };
}

function renderSelfUpdate(update: SelfUpdate, changelog = "") {
  return renderWithProviders(
    <UpdateDialog
      current="2.1.0"
      latest={{ version: "v2.2.0", changelog, download: RELEASES }}
      onOpenChange={() => {}}
      open
      selfUpdate={update}
      server={LINUX}
    />,
  );
}

describe("UpdateDialog self-update", () => {
  it("puts the download right under the changes", async () => {
    const update = selfUpdate();
    const { user } = renderSelfUpdate(update, CHANGELOG);
    expect(await screen.findByRole("list", { name: "What's new" })).toBeInTheDocument();
    expect(screen.getByText("Kiro Proxy 2.2.0")).toBeInTheDocument();
    expect(screen.getByText(/Linux \(x64\) · kiro-proxy-linux-x64\.tar\.gz/)).toBeInTheDocument();
    expect(screen.getByText(/downloads the Linux \(x64\) build/)).toBeInTheDocument();
    // No steps by hand until asked for.
    expect(screen.queryByRole("radiogroup", { name: "Update method" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Download update" }));
    expect(update.start).toHaveBeenCalledOnce();
  });

  it("shows the download's progress", async () => {
    renderSelfUpdate(
      selfUpdate({
        phase: "downloading",
        status: {
          state: "downloading",
          supported: true,
          version: "2.2.0",
          progress: 45,
          downloaded: 4_194_304,
          total: 9_437_184,
        },
      }),
    );
    const meter = await screen.findByRole("meter", { name: "Update download" });
    expect(meter).toHaveAttribute("aria-valuenow", "45");
    expect(screen.getByText(/of .* · 45%/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download update" })).toBeNull();
  });

  it("restarts on the release once it is in place", async () => {
    const update = selfUpdate({
      phase: "ready",
      status: { state: "ready", supported: true, version: "2.2.0" },
    });
    const { user } = renderSelfUpdate(update);
    expect(await screen.findByText("Ready to install")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(update.restart).toHaveBeenCalledOnce();
  });

  it("says it is restarting, with no other action", async () => {
    renderSelfUpdate(selfUpdate({ phase: "restarting" }));
    expect(await screen.findByText("Restarting…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update by hand instead" })).toBeNull();
  });

  it("shows why it failed and tries again", async () => {
    const update = selfUpdate({
      phase: "error",
      error: "The download does not match the release checksum.",
    });
    const { user } = renderSelfUpdate(update);
    const line = await screen.findByRole("note");
    // One plain line: the reason only. Not an alert: the self-update reads it out once.
    expect(line).toHaveTextContent(/^The download does not match the release checksum\.$/);
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(update.start).toHaveBeenCalledOnce();
  });

  it("says the update did not finish when the server gave no reason", async () => {
    renderSelfUpdate(selfUpdate({ phase: "error" }));
    expect(await screen.findByRole("note")).toHaveTextContent("The update did not finish");
  });

  it("keeps the steps by hand one link away", async () => {
    const { user } = renderSelfUpdate(selfUpdate());
    await user.click(await screen.findByRole("button", { name: "Update by hand instead" }));
    expect(await screen.findByRole("radiogroup", { name: "Update method" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Update automatically" }));
    expect(await screen.findByRole("button", { name: "Download update" })).toBeInTheDocument();
  });
});

describe("UpdateDialog on a binary that cannot update itself", () => {
  it("says why a binary updates by hand when it cannot write its own folder", async () => {
    renderSelfUpdate(
      selfUpdate({
        available: false,
        status: {
          state: "idle",
          supported: false,
          reason: "not_writable",
          path: "/usr/local/bin/kiro-proxy",
        },
      }),
    );
    expect(await screen.findByText(/cannot write to/)).toBeInTheDocument();
    expect(screen.getByText("/usr/local/bin/kiro-proxy", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Update method" })).toBeInTheDocument();
  });
});
