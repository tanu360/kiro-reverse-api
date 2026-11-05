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
      "font-size": [{ text: ["2xs", "meta", "heading", "subtitle", "kpi", "title", "display"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
