import { createFileRoute } from "@tanstack/react-router";
import { RequestsPage } from "@/features/requests/requests-page";
import { validateRequestsSearch } from "../-search";

export const Route = createFileRoute("/_app/requests")({
  validateSearch: validateRequestsSearch,
  component: RequestsPage,
});
