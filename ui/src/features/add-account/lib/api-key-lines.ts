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
