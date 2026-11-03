import { createFileRoute } from "@tanstack/react-router";
import { AccountsPage } from "@/features/accounts/accounts-page";
import { validateAccountsSearch } from "../-search";

export const Route = createFileRoute("/_app/accounts")({
  validateSearch: validateAccountsSearch,
  component: AccountsPage,
});
