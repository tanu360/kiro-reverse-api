import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "@/features/overview/overview-page";
import { validateOverviewSearch } from "../-search";

export const Route = createFileRoute("/_app/")({
  validateSearch: validateOverviewSearch,
  component: OverviewPage,
});
