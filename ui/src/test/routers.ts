import type { AnyRouter } from "@tanstack/react-router";
import { waitFor } from "@testing-library/react";

/*
 * The routers renderApp made in the current test. A navigation a test starts can still be
 * loading when the test ends; if the test file's environment is torn down first, the router's
 * late state update throws "window is not defined" outside any test, which fails the run. Each
 * test therefore waits for its routers to settle before cleanup (setup.ts). This module stays
 * light, so setup.ts can import it without the route tree.
 */
const active = new Set<AnyRouter>();

export function trackRouter(router: AnyRouter): void {
  active.add(router);
}

/** Waits until every router of the test is idle, then forgets them. */
export async function settleRouters(): Promise<void> {
  for (const router of active) {
    await waitFor(() => {
      if (router.state.status !== "idle" || router.state.isLoading) {
        throw new Error("router still loading");
      }
    }).catch(() => {});
  }
  active.clear();
}
