import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { ErrorState } from "@/components/shared/error-state";
import { Card } from "@/components/ui/card";
import { KeyLimitsCard } from "@/features/api/key-usage-limits";
import { queryKeys } from "@/lib/api/query-keys";
import { signOutUser, userKeyQuery } from "@/lib/api/user-panel";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { ExampleRequestCard, UserEndpointsCard } from "./connect-cards";
import { KeyDetailsCard, KeyHeading, KeyNotice } from "./key-overview";
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
 * fail when it is off or expired, its limits and settings, usage over time and by model, its
 * own recent requests, and how to connect. Built from the admin pages' cards; it calls only
 * /user/api.
 */
export function UserPanelPage(): JSX.Element {
  const { t } = useT("user-panel");
  const queryClient = useQueryClient();
  const key = useQuery(userKeyQuery());
  const { signOut, signingOut } = useUserSignOut();
  const apiKey = key.data;
  const refreshing = queryClient.isFetching({ queryKey: queryKeys.userPanel.all }) > 0;

  return (
    <UserShell onSignOut={() => void signOut()} signingOut={signingOut}>
      <KeyHeading
        apiKey={apiKey}
        fetching={key.isFetching || refreshing}
        onRefresh={() => void queryClient.refetchQueries({ queryKey: queryKeys.userPanel.all })}
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
          <KeyLimitsCard apiKey={apiKey} />
          <KeyDetailsCard apiKey={apiKey} />
          <UsageSection />
          <RecentRequestsCard />
          <div className="grid min-w-0 grid-cols-1 gap-4 md:gap-6 xl:grid-cols-2">
            <UserEndpointsCard />
            <ExampleRequestCard allowedModels={apiKey?.allowedModels ?? []} />
          </div>
        </>
      )}
    </UserShell>
  );
}
