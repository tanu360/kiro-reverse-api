import { authKey } from "@/features/accounts/account-model";
import type { Account } from "@/lib/api/types";
import type { AddAccountMethod } from "../add-account-dialog";

/** The providers the Kiro web cookie flow offers. */
export type CookieProvider = "Google" | "Github";

/**
 * The add-account method a re-login opens with, from how the account signed in. There is no
 * interactive Google or GitHub sign-in, so social accounts open the web cookie flow; anything
 * unknown opens the credentials JSON, which takes every kind.
 */
export function reloginMethod(account: Pick<Account, "provider" | "authMethod">): AddAccountMethod {
  switch (authKey(account)) {
    case "builderId":
      return "builderid";
    case "enterprise":
      return "iam";
    case "microsoft":
      return "microsoft";
    case "social":
    case "google":
    case "github":
      return "cookie";
    case "apiKey":
      return "apikey";
    default:
      return "credentials";
  }
}

/** The cookie flow's provider for a social account: GitHub when it says so, else Google. */
export function reloginCookieProvider(account: Pick<Account, "provider"> | null): CookieProvider {
  return account?.provider.toLowerCase() === "github" ? "Github" : "Google";
}

/** The region field's start value: the account's OAuth region, or the usual default. */
export function reloginRegion(account: Pick<Account, "region"> | null): string {
  return account?.region || "us-east-1";
}
