import { createContext, type JSX, type ReactNode, useContext } from "react";
import type { Account } from "@/lib/api/types";

type OpenRelogin = (account: Account) => void;

const ReloginContext = createContext<OpenRelogin | null>(null);

/**
 * Lets every account menu below it open the add-account dialog in re-login mode for its account.
 * The component that renders that dialog provides it: the accounts page for its table rows and
 * phone cards, the detail sheet for its own menu (so it works on every page that opens the sheet).
 */
export function ReloginProvider({
  onRelogin,
  children,
}: {
  onRelogin: OpenRelogin;
  children: ReactNode;
}): JSX.Element {
  return <ReloginContext.Provider value={onRelogin}>{children}</ReloginContext.Provider>;
}

/** Opens "Sign in again" for an account; null outside a ReloginProvider, where the item hides. */
export function useOpenRelogin(): OpenRelogin | null {
  return useContext(ReloginContext);
}
