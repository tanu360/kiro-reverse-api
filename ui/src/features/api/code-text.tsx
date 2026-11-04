import { Fragment, type JSX } from "react";

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
  const parts: Array<string | JSX.Element> = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    const value = name === undefined ? undefined : code[name];
    if (value === undefined) continue;
    parts.push(text.slice(last, match.index));
    parts.push(
      <code className="inline-code whitespace-nowrap" key={match.index}>
        {value}
      </code>,
    );
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return (
    <>
      {parts.map((part, index) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one sentence never reorder.
        typeof part === "string" ? <Fragment key={index}>{part}</Fragment> : part,
      )}
    </>
  );
}
