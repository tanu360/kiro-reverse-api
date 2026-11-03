import type { ModelMappingRule } from "@/lib/api/types";

/** One editable mapping row. `id` is local only: a stable key for React and drag and drop. */
export interface MappingRow {
  id: string;
  key: string;
  value: string;
}

let nextRowId = 0;

export function newRowId(): string {
  nextRowId += 1;
  return `mapping-${nextRowId}`;
}

/**
 * Editable rows for the server's rules. A row of `previous` at the same position with the same
 * rule (the server lowercases keys) lends its id, so re-reading a saved list keeps rows mounted.
 */
export function rowsFromRules(
  rules: readonly ModelMappingRule[],
  previous: readonly MappingRow[] = [],
): MappingRow[] {
  return rules.map((rule, i) => {
    const before = previous[i];
    const same =
      before !== undefined &&
      before.key.toLowerCase() === rule.key.toLowerCase() &&
      before.value === rule.value;
    return { id: same ? before.id : newRowId(), key: rule.key, value: rule.value };
  });
}

/** Same rules in the same order; row ids do not count. */
export function sameMappings(a: readonly MappingRow[], b: readonly MappingRow[]): boolean {
  return (
    a.length === b.length && a.every((row, i) => row.key === b[i].key && row.value === b[i].value)
  );
}

/**
 * The list to send: both fields trimmed, rows blank on both sides dropped, half-filled rows
 * kept so the server can name them. `rowIndexes[i]` is the local row of sent rule `i`.
 */
export function prepareMappings(rows: readonly MappingRow[]): {
  mappings: ModelMappingRule[];
  rowIndexes: number[];
} {
  const mappings: ModelMappingRule[] = [];
  const rowIndexes: number[] = [];
  rows.forEach((row, index) => {
    const key = row.key.trim();
    const value = row.value.trim();
    if (!key && !value) return;
    mappings.push({ key, value });
    rowIndexes.push(index);
  });
  return { mappings, rowIndexes };
}

/** The local row for a server error `index`; null for -1, no index or one out of range. */
export function localRowForServerIndex(
  rowIndexes: readonly number[],
  index: number | null | undefined,
): number | null {
  if (index === null || index === undefined || index < 0 || index >= rowIndexes.length) {
    return null;
  }
  return rowIndexes[index];
}

/** A copy with the row at `from` moved to `to`; the same array when `to` is out of bounds. */
export function moveRow<T>(rows: readonly T[], from: number, to: number): readonly T[] {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return rows;
  const next = [...rows];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
