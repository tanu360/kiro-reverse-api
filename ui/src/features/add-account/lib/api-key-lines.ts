import type { CredentialsImportRequest } from "@/lib/api/types";

/**
 * One import request per non-blank line. A key written as `ksk_...|region` carries its own
 * region, so the selected region is sent only for plain keys.
 */
export function parseApiKeyLines(text: string, region: string): CredentialsImportRequest[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((key) => ({
      kiroApiKey: key,
      authMethod: "api_key",
      region: key.includes("|") ? "" : region,
    }));
}

/**
 * The region a `ksk_...|region` key names, trimmed and lowercased as the server reads it
 * (config.SplitKiroAPIKeyAndRegion); null for a key without one.
 */
export function keyRegion(key: string): string | null {
  const bar = key.indexOf("|");
  return bar < 0
    ? null
    : key
        .slice(bar + 1)
        .trim()
        .toLowerCase();
}
