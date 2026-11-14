import { createFileRoute } from "@tanstack/react-router";
import { redirectToSectionPage } from "@/features/settings/lib/page-redirect";
import { SettingsPage } from "@/features/settings/settings-page";

export const Route = createFileRoute("/_app/settings/")({
  beforeLoad: ({ location }) => redirectToSectionPage("requests", location.hash),
  component: () => <SettingsPage page="requests" />,
});
