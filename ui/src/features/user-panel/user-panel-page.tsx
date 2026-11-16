import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { ErrorState } from "@/components/shared/error-state";
import { Card } from "@/components/ui/card";
import { ClientSnippetsCard } from "@/features/api/client-snippets";
import { EndpointsCard } from "@/features/api/endpoints-card";
import { queryKeys } from "@/lib/api/query-keys";
import { signOutUser, userKeyQuery } from "@/lib/api/user-panel";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { KeyHeading, KeyNotice } from "./key-overview";
import { useRerenderAtExpiry } from "./key-status";
import { RecentRequestsCard } from "./recent-requests-card";
import { UsageSection } from "./usage-section";
import { UserShell } from "./user-shell";

/**
 * Sign out: revoke the session (errors ignored). The cleared session takes the page to the key
 * sign-in page through useUserSessionRedirects, once; navigating here too pushed /user/login twice.
 */
function useUserSignOut(): { signOut: () => Promise<void>; signingOut: boolean } {
  const [signingOut, setSigningOut] = useState(false);
  return {
    signingOut,
    signOut: async () => {
      setSigningOut(true);
      toast.dismiss();
      await signOutUser();
    },
  };
}

/**
 * /user: everything about the signed-in API key and nothing else. Its status and why requests
 * fail when it is off or expired, its usage against its limits, its settings, usage over time
 * and by model, its own recent requests, and how to connect. Built from the admin pages' cards; it calls only
 * /user/api.
 */
export function UserPanelPage(): JSX.Element {
  const { t } = useT("user-panel");
  const queryClient = useQueryClient();
  const key = useQuery(userKeyQuery());
  const { signOut, signingOut } = useUserSignOut();
  const apiKey = key.data;
  // The badge, notice and key facts read the clock: they turn to Expired when the expiry passes.
  useRerenderAtExpiry(apiKey?.expiresAt ?? 0);
  // Subscribed, so Refresh stops spinning when the last panel query settles, not at the next
  // render something else happens to cause.
  const refreshing = useIsFetching({ queryKey: queryKeys.userPanel.all }) > 0;

  return (
    <UserShell onSignOut={() => void signOut()} signingOut={signingOut}>
      <KeyHeading
        apiKey={apiKey}
        failed={key.isError}
        fetching={key.isFetching || refreshing}
        // Only the queries on screen: a cached range or page would spend the key's usage budget
        // (20 builds a minute) too, and it loads again when shown once stale.
        onRefresh={() =>
          void queryClient.refetchQueries({ queryKey: queryKeys.userPanel.all, type: "active" })
        }
      />
      {key.isError && !apiKey ? (
        <Card>
          <ErrorState
            error={key.error}
            onRetry={() => void key.refetch()}
            retrying={key.isFetching}
            title={t("loadFailed")}
          />
        </Card>
      ) : (
        <>
          {apiKey ? <KeyNotice apiKey={apiKey} /> : null}
          <UsageSection apiKey={apiKey} />
          <RecentRequestsCard />
          {/* The admin API page's two cards, fed from the key: they never read /admin/api.
              Until the key loads they assume keys are required, as the key's own default. */}
          <div className="grid min-w-0 grid-cols-1 gap-4 md:gap-6 xl:grid-cols-2">
            <EndpointsCard requireApiKey={apiKey?.keysRequired ?? true} />
            <ClientSnippetsCard
              // A key limited to models asks for the first of them, so the examples work as pasted.
              model={apiKey?.allowedModels[0]}
              requireApiKey={apiKey?.keysRequired ?? true}
            />
          </div>
        </>
      )}
    </UserShell>
  );
}
