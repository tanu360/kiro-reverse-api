/** config.MaxCountTokensURLLen */
export const MAX_COUNT_TOKENS_URL_LENGTH = 2048;

/**
 * The URL check config.ValidateCountTokensURL makes: http or https, a host, no user name or
 * password (secrets go in the key field), no spaces or control characters.
 */
export function validCountTokensUrl(raw: string): boolean {
  if (!raw || raw.length > MAX_COUNT_TOKENS_URL_LENGTH) return false;
  if (/[\s\p{Cc}]/u.test(raw)) return false;
  // The browser's parser reads "https:///x" as host "x"; Go finds no host there.
  if (!/^https?:\/\/[^/?#]/i.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname !== "" && url.username === "" && url.password === "";
}

/** proxy/count_tokens_remote.go maskCountTokensKey: the last 4 of a key of 12 or more. */
export function maskCountTokensKey(key: string): string {
  if (!key) return "";
  const chars = Array.from(key);
  return chars.length < 12 ? "••••" : `••••${chars.slice(-4).join("")}`;
}
