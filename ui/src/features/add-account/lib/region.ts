export const DEFAULT_REGION = "us-east-1";

/** The server's region check (config/region.go). */
const REGION_RE = /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/;

/** Trims and lowercases a free-text region like the server does; empty means us-east-1. */
export function parseRegion(raw: string): { ok: true; region: string } | { ok: false } {
  const region = raw.trim().toLowerCase();
  if (!region) return { ok: true, region: DEFAULT_REGION };
  return REGION_RE.test(region) ? { ok: true, region } : { ok: false };
}
