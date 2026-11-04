import { MOCK_SCENARIOS, type MockScenario } from "./db";

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
