import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge that knows the type scale's own steps (index.css @theme --text-*). Without
 * them it reads `text-display` as a colour, so `cn("text-display", "text-destructive-foreground")`
 * would drop the size.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["2xs", "meta", "heading", "subtitle", "kpi", "title", "display", "control"] },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Pairs each item with a React key made from its text and how often that text came before it
 * ("0:a", "0:b", "1:a"), for lists with no ids (lines of code, parts of a sentence): the keys
 * follow the content, and repeated text still gets a key of its own.
 */
export function keyByText<T>(
  items: readonly T[],
  textOf: (item: T) => string,
): { key: string; item: T }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const text = textOf(item);
    const count = seen.get(text) ?? 0;
    seen.set(text, count + 1);
    return { key: `${count}:${text}`, item };
  });
}

/**
 * Keys for `count` loading placeholders, which have no data of their own: `name-1`, `name-2`, …
 * The same count always gives the same keys, so a placeholder list keeps its elements.
 */
export function placeholderKeys(name: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${name}-${index + 1}`);
}
