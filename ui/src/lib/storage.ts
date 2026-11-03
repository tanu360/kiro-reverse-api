// Guarded Web Storage access. Private mode, blocked site data or a sandboxed frame can make the
// storage accessor itself throw, so every read and write goes through try/catch.

type StorageArea = "local" | "session";

function getArea(area: StorageArea): Storage | null {
  try {
    return area === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

export function readStorage(key: string, area: StorageArea = "local"): string | null {
  try {
    return getArea(area)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Writes `value`, or removes the key when `value` is null. Failures are ignored. */
export function writeStorage(key: string, value: string | null, area: StorageArea = "local"): void {
  try {
    const storage = getArea(area);
    if (!storage) return;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Quota exceeded or storage blocked: the preference is simply not persisted.
  }
}
