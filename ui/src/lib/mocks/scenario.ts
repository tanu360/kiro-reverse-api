import { MOCK_SCENARIOS, type MockScenario } from "./db";
import { MOCK_SERVER_KINDS, type MockServerKind } from "./update";

// Picks the browser mock's dataset without restarting the dev server:
//   ?mock=full|small|empty  switches and is remembered for the tab (sessionStorage);
//   localStorage kiro_mock_scenario pins a default (the e2e specs pin `small`);
//   otherwise `full`.

const PARAM = "mock";
const KEY = "kiro_mock_scenario";
const DEFAULT: MockScenario = "full";

function asScenario(value: string | null | undefined): MockScenario | null {
  const normalized = (value ?? "").trim().toLowerCase();
  return (MOCK_SCENARIOS as readonly string[]).includes(normalized)
    ? (normalized as MockScenario)
    : null;
}

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    // Storage blocked (private mode, sandboxed frame): fall through to the next source.
    return null;
  }
}

export function resolveMockScenario(): MockScenario {
  const fromUrl = asScenario(new URLSearchParams(window.location.search).get(PARAM));
  if (fromUrl) {
    try {
      sessionStorage.setItem(KEY, fromUrl);
    } catch {
      // Not remembered: the URL parameter still applies to this load.
    }
    return fromUrl;
  }
  return (
    asScenario(read(() => sessionStorage, KEY)) ??
    asScenario(read(() => localStorage, KEY)) ??
    DEFAULT
  );
}

// What the mock server runs as, for the update dialog (update.ts):
//   ?server=binary|docker|windows|readonly|fail  switches and is remembered for the tab;
//   otherwise `binary`, a Linux binary that updates itself.

const SERVER_PARAM = "server";
const SERVER_KEY = "kiro_mock_server";

function asServerKind(value: string | null | undefined): MockServerKind | null {
  const normalized = (value ?? "").trim().toLowerCase();
  return (MOCK_SERVER_KINDS as readonly string[]).includes(normalized)
    ? (normalized as MockServerKind)
    : null;
}

export function resolveMockServer(): MockServerKind {
  const fromUrl = asServerKind(new URLSearchParams(window.location.search).get(SERVER_PARAM));
  if (fromUrl) {
    try {
      sessionStorage.setItem(SERVER_KEY, fromUrl);
    } catch {
      // Not remembered: the URL parameter still applies to this load.
    }
    return fromUrl;
  }
  return asServerKind(read(() => sessionStorage, SERVER_KEY)) ?? "binary";
}
