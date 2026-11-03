import { createFileRoute } from "@tanstack/react-router";
import { ApiPage } from "@/features/api/api-page";

export const Route = createFileRoute("/_app/api")({
  component: ApiPage,
});
