import type { PromptFilterConfig, PromptFilterRule } from "@/lib/api/types";
import { isEqual } from "./dirty";
import { compilesInGo } from "./go-regex";

/** The two rule kinds the UI creates; the server also reads `contains` as a line filter. */
export type RuleKind = "regex" | "lines-containing";

export function isRegexRule(rule: Pick<PromptFilterRule, "type">): boolean {
  return rule.type === "regex";
}

/**
 * A new enabled rule with an empty match and the id `rule-<ms>` like the old UI, bumped past
 * ids already in `existing` when two rules are added within one millisecond.
 */
export function newRule(
  type: RuleKind,
  existing: readonly PromptFilterRule[] = [],
  now: number = Date.now(),
): PromptFilterRule {
  let stamp = now;
  while (existing.some((rule) => rule.id === `rule-${stamp}`)) stamp += 1;
  return { id: `rule-${stamp}`, name: "", type, match: "", replace: "", enabled: true };
}

/**
 * True when Go's `regexp.Compile` rejects `match`: the proxy compiles rules with it and skips one
 * that fails. A hint only; it never blocks saving.
 */
export function regexFails(match: string): boolean {
  return !compilesInGo(match);
}

function normalized(config: PromptFilterConfig): PromptFilterConfig {
  // The server omits an empty `replace`; a missing one and '' mean the same.
  return {
    ...config,
    rules: config.rules.map((rule) => ({ ...rule, replace: rule.replace ?? "" })),
  };
}

export function samePromptFilter(a: PromptFilterConfig, b: PromptFilterConfig): boolean {
  return isEqual(normalized(a), normalized(b));
}

/** The full body for POST /prompt-filter: all three switches and every rule. */
export function promptFilterBody(config: PromptFilterConfig): PromptFilterConfig {
  return {
    filterClaudeCode: config.filterClaudeCode,
    filterEnvNoise: config.filterEnvNoise,
    filterStripBoundaries: config.filterStripBoundaries,
    rules: config.rules,
  };
}
