import { type Lang, registerMessages, type TFunction, useT } from "@/lib/i18n";

/**
 * Strings the shared primitives render themselves (accessible names, screen-reader summaries).
 * They live next to the components in the `ui` namespace so a primitive never ships a hardcoded
 * English label. Read them with `useUiT()`, which also keeps this module (and its registration)
 * in the bundle of every component that needs it.
 */
export const UI_NAMESPACE = "ui";

const en = {
  "autocomplete.showOptions": "Show options",
  "autocomplete.clear": "Clear",
  "numberField.decrease": "Decrease",
  "numberField.increase": "Increase",
  "hint.more": "More information",
  "sparkline.empty": "No data",
  "sparkline.summary": "{count} points, from {first} to {last}",
  "sparkline.summaryUp": "{count} points, from {first} to {last}, up {change}%",
  "sparkline.summaryDown": "{count} points, from {first} to {last}, down {change}%",
} as const;

const zh: Record<keyof typeof en, string> = {
  "autocomplete.showOptions": "显示选项",
  "autocomplete.clear": "清除",
  "numberField.decrease": "减少",
  "numberField.increase": "增加",
  "hint.more": "更多信息",
  "sparkline.empty": "暂无数据",
  "sparkline.summary": "{count} 个数据点，从 {first} 到 {last}",
  "sparkline.summaryUp": "{count} 个数据点，从 {first} 到 {last}，上升 {change}%",
  "sparkline.summaryDown": "{count} 个数据点，从 {first} 到 {last}，下降 {change}%",
};

registerMessages("en", UI_NAMESPACE, en);
registerMessages("zh", UI_NAMESPACE, zh);

/** `useT` bound to the primitives' own namespace. */
export function useUiT(): { t: TFunction; lang: Lang } {
  return useT(UI_NAMESPACE);
}
