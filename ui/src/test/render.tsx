import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
  RouterProvider,
} from "@tanstack/react-router";
import { act, type RenderResult, render, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { ConfirmProvider } from "@/components/shared/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setSession } from "@/lib/auth/session";
import { I18nProvider, type Lang } from "@/lib/i18n";
import { PrivacyProvider } from "@/lib/privacy";
import { routeTree } from "@/routeTree.gen";

// jsdom has no Web Animations API; Base UI's ScrollArea (sidebar content) calls
// getAnimations() from a timer. test/setup.ts belongs to the data-layer task, so the shell's
// render helpers install the stub they need.
if (typeof Element !== "undefined" && !Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

export interface RenderOptions {
  lang?: Lang;
  privacy?: boolean;
  authed?: boolean;
  queryClient?: QueryClient;
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

function prepare(options: RenderOptions): { queryClient: QueryClient; lang: Lang } {
  const queryClient = options.queryClient ?? createTestQueryClient();
  if (options.authed ?? true) {
    setSession({ token: "mock-test", expiresAt: Date.now() + 3_600_000, remember: false });
  }
  return { queryClient, lang: options.lang ?? "en" };
}

/** The app's provider tree (main.tsx) without the router. */
function Providers({
  children,
  queryClient,
  lang,
  privacy,
}: {
  children: ReactNode;
  queryClient: QueryClient;
  lang: Lang;
  privacy?: boolean;
}): ReactElement {
  return (
    <ThemeProvider>
      <I18nProvider initialLang={lang}>
        <PrivacyProvider initialEnabled={privacy}>
          <QueryClientProvider client={queryClient}>
            <ToastProvider limit={5}>
              <TooltipProvider>
                <ConfirmProvider>{children}</ConfirmProvider>
              </TooltipProvider>
            </ToastProvider>
          </QueryClientProvider>
        </PrivacyProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

/**
 * Renders `ui` inside every app provider and a memory router whose only route renders it,
 * so Link and useNavigate work. The router context is provided directly, so the first render
 * is synchronous (RouterProvider would render the matched route only after it loads).
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderOptions = {},
): RenderResult & { user: UserEvent; queryClient: QueryClient } {
  const { queryClient, lang } = prepare(options);
  const rootRoute = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const user = userEvent.setup();
  const result = render(
    <Providers lang={lang} privacy={options.privacy} queryClient={queryClient}>
      <RouterContextProvider router={router}>{ui}</RouterContextProvider>
    </Providers>,
  );
  return { ...result, user, queryClient };
}

/**
 * Renders the real route tree at '/admin' + path in memory history and waits until the
 * router settles (guards and redirects included).
 */
export async function renderApp(
  path: string,
  options: RenderOptions = {},
): Promise<RenderResult & { user: UserEvent; queryClient: QueryClient; router: AnyRouter }> {
  const { queryClient, lang } = prepare(options);
  const router = createRouter({
    routeTree,
    basepath: "/admin",
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`/admin${path}`] }),
  });
  const user = userEvent.setup();
  const result = render(
    <Providers lang={lang} privacy={options.privacy} queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  await act(async () => {
    await router.load();
  });
  await waitFor(() => {
    if (router.state.status !== "idle" || router.state.isLoading) {
      throw new Error("router still loading");
    }
  });
  return { ...result, user, queryClient, router };
}
