import { describe, expect, it } from "vitest";
import allowlist from "./hardcoded-text-allowlist.json";
import { type Finding, scanSource } from "./i18n-scan";

// Every source file as text, keyed by its path from the ui/ root ("/src/...").
const sources = import.meta.glob<string>("/src/**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
});

// Not shipped or not UI: tests and their helpers, MSW fixtures (dev-only mock data that never
// reaches dist) and the generated route tree.
const SKIPPED = [
  /\.test\.tsx?$/,
  /^src\/test\//,
  /^src\/lib\/mocks\//,
  /^src\/features\/[^/]+\/mocks\.ts$/,
  /^src\/routeTree\.gen\.ts$/,
];

function scanAll(): Finding[] {
  return Object.entries(sources).flatMap(([path, code]) => {
    const file = path.replace(/^\//, "");
    if (SKIPPED.some((pattern) => pattern.test(file))) return [];
    return scanSource(code, file);
  });
}

interface AllowlistEntry {
  file: string;
  text: string;
  reason: string;
}

const entries = allowlist as AllowlistEntry[];

function isAllowed(finding: Finding): boolean {
  return entries.some((entry) => entry.file === finding.file && entry.text === finding.text);
}

describe("hardcoded user-visible text", () => {
  const findings = scanAll();

  it("scans the whole source tree", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(200);
  });

  it("finds no literal text outside the locale files", () => {
    const offending = findings
      .filter((finding) => !isAllowed(finding))
      .map((finding) => `${finding.file}:${finding.line} [${finding.kind}] ${finding.text}`);
    expect(offending, "move these strings into the locale files or allowlist them").toEqual([]);
  });

  it("gives every allowlist entry a one-line reason", () => {
    const bad = entries.filter(
      (entry) =>
        typeof entry.reason !== "string" || !entry.reason.trim() || /\n/.test(entry.reason),
    );
    expect(bad).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const stale = entries.filter(
      (entry) => !findings.some((f) => f.file === entry.file && f.text === entry.text),
    );
    expect(stale).toEqual([]);
  });
});

describe("scanSource", () => {
  const scan = (code: string) => scanSource(code, "fixture.tsx").map((f) => `${f.kind}: ${f.text}`);

  it("flags JSX text, visible props, string children and toast/confirm arguments", () => {
    expect(
      scan(`
        export function A() {
          toast.success("Saved the file");
          confirm("Really?");
          document.title = "Accounts";
          const item = { label: "Overview" };
          return (
            <div aria-label="Close dialog" title={ok ? "Yes" : "No"} placeholder={\`Search\`}>
              Hello world
              {busy ? "Saving" : null}
            </div>
          );
        }
      `),
    ).toEqual([
      "toast.success: Saved the file",
      "confirm: Really?",
      "document.title: Accounts",
      "property label: Overview",
      "prop aria-label: Close dialog",
      "prop title: Yes",
      "prop title: No",
      "prop placeholder: Search",
      "jsx-text: Hello world",
      "jsx-child: Saving",
    ]);
  });

  it("flags sentences glued together from translated parts", () => {
    expect(
      scan(`
        export function A() {
          return <button aria-label={\`\${t("current")}: \${version}. \${hint}\`} title={\`\${a} · \${b}\`} />;
        }
      `),
    ).toEqual(["prop aria-label composed: {…}: {…}. {…}"]);
  });

  it("allows translation calls, keys, tokens, code, numbers and non-visible props", () => {
    expect(
      scan(`
        export function A() {
          toast.error(t("saveFailed"));
          const item = { labelKey: "shell.nav.overview", hint: "microsoftChoiceHint" };
          return (
            <div aria-label={t("close")} className="flex gap-2" data-state="open" title="Kiro Proxy">
              {t("title")} · 42 %
              <Code>~/.aws/sso/cache/</Code>
              <Kbd>Ctrl K</Kbd>
              JSON URL OpenAI
              <span label="var(--chart-label)" />
            </div>
          );
        }
      `),
    ).toEqual([]);
  });
});
