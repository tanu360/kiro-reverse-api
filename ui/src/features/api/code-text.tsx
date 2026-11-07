import { Fragment, type JSX } from "react";
import { Code } from "@/components/shared/code";

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Renders a translated sentence whose `{name}` placeholders are wire names, each as inline code.
 * Pass the raw message (t(key) without params keeps the placeholders).
 */
export function CodeText({
  text,
  code,
}: {
  text: string;
  code: Record<string, string>;
}): JSX.Element {
  // Each part is keyed by where it starts in the sentence.
  const parts: JSX.Element[] = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    const value = name === undefined ? undefined : code[name];
    if (value === undefined) continue;
    parts.push(<Fragment key={`text-${last}`}>{text.slice(last, match.index)}</Fragment>);
    parts.push(<Code key={`code-${match.index}`}>{value}</Code>);
    last = match.index + match[0].length;
  }
  parts.push(<Fragment key={`text-${last}`}>{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}
