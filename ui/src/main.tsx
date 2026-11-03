import "@fontsource-variable/inter";
import "@fontsource-variable/geist-mono";
import "./index.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppToastProvider } from "@/components/layout/app-toasts";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { ConfirmProvider } from "@/components/shared/confirm-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/lib/i18n";
import { PrivacyProvider } from "@/lib/privacy";
import { queryClient } from "@/lib/query-client";
import { router } from "./router";

async function bootstrap(): Promise<void> {
  // Statically false in production builds, so MSW and the fixtures never ship.
  if (import.meta.env.VITE_MOCK === "1") {
    const { startMockWorker } = await import("@/lib/mocks/browser");
    await startMockWorker();
  }

  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Missing #root element");

  createRoot(rootElement).render(
    <StrictMode>
      <ThemeProvider>
        <I18nProvider>
          <PrivacyProvider>
            <QueryClientProvider client={queryClient}>
              <AppToastProvider>
                <TooltipProvider>
                  <ConfirmProvider>
                    <RouterProvider router={router} />
                  </ConfirmProvider>
                </TooltipProvider>
              </AppToastProvider>
            </QueryClientProvider>
          </PrivacyProvider>
        </I18nProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}

void bootstrap();
