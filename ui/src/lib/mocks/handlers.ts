import type { HttpHandler } from "msw";
import { coreHandlers } from "./core-handlers";

// Each feature owns src/features/<feature>/mocks.ts with `export const handlers`. They are
// collected here, so no feature edits a shared registry.
const featureModules = import.meta.glob<{ handlers?: HttpHandler[] }>("/src/features/*/mocks.ts", {
  eager: true,
});

/** Core handlers plus every feature's mocks.ts. */
export const allHandlers: HttpHandler[] = [
  ...coreHandlers,
  ...Object.values(featureModules).flatMap((module) => module.handlers ?? []),
];
