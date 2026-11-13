import { useQuery } from "@tanstack/react-query";
import { type JSX, lazy, type ReactNode, Suspense, useCallback, useState } from "react";
import { accountsQuery } from "@/lib/api/accounts";
import type { Account } from "@/lib/api/types";
import { ReloginProvider } from "./relogin-context";

// The dialog's code loads on first use, so a page that only lists accounts does not carry it.
const AddAccountDialog = lazy(() =>
  import("@/features/add-account/add-account-dialog").then((module) => ({
    default: module.AddAccountDialog,
  })),
);

/**
 * "Sign in again" for every account menu below it, on a page that has no add-account dialog of
 * its own (the Overview's accounts card). The dialog follows the account in the list cache.
 */
export function ReloginHost({ children }: { children: ReactNode }): JSX.Element {
  const { data } = useQuery(accountsQuery());
  const [target, setTarget] = useState<{ id: string; open: boolean; session: number } | null>(null);
  const onRelogin = useCallback(
    (account: Account) =>
      setTarget((current) => ({
        id: account.id,
        open: true,
        session: (current?.session ?? 0) + 1,
      })),
    [],
  );
  const account = target ? data?.find((item) => item.id === target.id) : undefined;
  return (
    <ReloginProvider onRelogin={onRelogin}>
      {children}
      {target && account ? (
        <Suspense fallback={null}>
          <AddAccountDialog
            key={`relogin-${target.session}`}
            onOpenChange={(next) =>
              setTarget((current) => (current ? { ...current, open: next } : null))
            }
            open={target.open}
            relogin={account}
          />
        </Suspense>
      ) : null}
    </ReloginProvider>
  );
}
