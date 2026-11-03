import type { HttpHandler } from "msw";
import { coreHandlers } from "./core-handlers";

/** Core handlers plus every feature's mocks.ts. Skeleton: core handlers only. */
export const allHandlers: HttpHandler[] = [...coreHandlers];
