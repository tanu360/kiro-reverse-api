// Account notes and tags: the limits and normalization the server applies
// (config/account_metadata.go), so the UI can refuse over-limit input before it is sent.

import type { Account } from "@/lib/api/types";

/** Notes are cut at this many characters. */
export const MAX_NOTES = 2000;
/** An account holds at most this many tags. */
export const MAX_TAGS = 10;
/** A tag is cut at this many characters (code points, as the server counts runes). */
export const MAX_TAG_LENGTH = 24;

/**
 * Commas separate tags; the CJK full-width comma and the enumeration comma count too. The
 * server (isAccountTagSeparator) turns them into spaces, so no stored tag holds one.
 */
const TAG_SEPARATOR = /[,，、]/;
const TAG_SEPARATORS = /[,，、]/g;

/**
 * Control characters go (a newline or tab becomes a space), a separator becomes a space,
 * whitespace runs collapse.
 */
function cleanTag(raw: string): string {
  return (
    raw
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips.
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => (/\s/.test(char) ? " " : ""))
      .replace(TAG_SEPARATORS, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function codePoints(text: string): number {
  return [...text].length;
}

/** The key tags are compared by: the server dedupes and matches them ignoring case. */
export function tagKey(tag: string): string {
  return tag.toLowerCase();
}

/** One tag as the server stores it: cleaned, then cut to MAX_TAG_LENGTH code points. */
export function normalizeTag(raw: string): string {
  return [...cleanTag(raw)].slice(0, MAX_TAG_LENGTH).join("").trim();
}

/** Normalized, empty and duplicate tags (ignoring case, first spelling wins) dropped, at most MAX_TAGS. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (!tag || seen.has(tagKey(tag))) continue;
    seen.add(tagKey(tag));
    out.push(tag);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

export type TagInputError = { kind: "tooMany" } | { kind: "tooLong"; tag: string };

/**
 * The tags typed into the comma-separated field. Unlike the server, it refuses instead of
 * cutting: a tag over MAX_TAG_LENGTH, or more than MAX_TAGS distinct tags, is an error to show.
 */
export function parseTagInput(text: string): { tags: string[]; error?: TagInputError } {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const piece of text.split(TAG_SEPARATOR)) {
    const tag = cleanTag(piece);
    if (!tag) continue;
    if (codePoints(tag) > MAX_TAG_LENGTH) return { tags, error: { kind: "tooLong", tag } };
    if (seen.has(tagKey(tag))) continue;
    seen.add(tagKey(tag));
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS) return { tags, error: { kind: "tooMany" } };
  return { tags };
}

/** Whether the account has the tag, ignoring case. */
export function hasTag(account: Pick<Account, "tags">, tag: string): boolean {
  const key = tagKey(tag);
  return (account.tags ?? []).some((existing) => tagKey(existing) === key);
}

/** A text field's selection, as `selectionStart` and `selectionEnd` read it. */
export interface FieldSelection {
  start: number;
  end: number;
}

/**
 * The real text after an edit of the masked copy a field shows (a quick-pick tag under privacy).
 * `selection` is the field's selection just before the edit, or null when it was not seen.
 * Replacing the whole masked text (select all, then type, paste or delete) gives just the new
 * text. An edit next to characters the mask keeps as they are, such as the head "op" or the tail
 * ".com" of "op***@ex***.com", lands at the same place in the real text. An edit among the masked
 * characters has no real place to go, so it gives the real text unchanged.
 */
export function editMaskedText(
  real: string,
  masked: string,
  next: string,
  selection: FieldSelection | null,
): string {
  let same = 0;
  while (same < masked.length && same < next.length && masked[same] === next[same]) same += 1;
  // The edit replaced masked[start, cut) with next[start, next.length - kept).
  const start = Math.min(same, selection?.start ?? same, selection?.end ?? same);
  const selectionEnd = Math.max(start, selection?.start ?? start, selection?.end ?? start);
  const maxKept = Math.max(0, Math.min(masked.length - selectionEnd, next.length - start));
  let kept = 0;
  while (kept < maxKept && masked[masked.length - 1 - kept] === next[next.length - 1 - kept]) {
    kept += 1;
  }
  const cut = masked.length - kept;
  const typed = next.slice(start, next.length - kept);
  if (start === 0 && cut === masked.length) return typed;
  const after = masked.slice(start);
  if (real.endsWith(after)) {
    return real.slice(0, real.length - after.length) + typed + masked.slice(cut);
  }
  const before = masked.slice(0, cut);
  if (real.startsWith(before)) return masked.slice(0, start) + typed + real.slice(cut);
  return real;
}
