import { CircleCheckIcon, Link01Icon, XIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { NoticeIconButton, NoticeLine } from "@/components/shared/notice-line";
import { tunnelQuery } from "@/lib/api/tunnel";
import { useT } from "@/lib/i18n";

/**
 * Where a key holder signs in with their own key to see that key's usage (the /user page): on
 * the public link while it is live, since the admin's own address is often localhost or a LAN
 * address the holder cannot open; else this page's origin.
 */
function useUserPanelUrl(): string {
  const { data: publicUrl } = useQuery({
    ...tunnelQuery(),
    select: (status) => (status.state === "running" ? status.url : undefined),
  });
  return `${publicUrl ?? window.location.origin}/user`;
}

/** The secret as the table masks a key: its first six and last four characters. */
function maskSecret(secret: string): string {
  return secret.length > 12 ? `${secret.slice(0, 6)}****${secret.slice(-4)}` : secret;
}

/**
 * The full secret from the last create or regenerate, as one green line: "New API key" and the
 * masked key, then bare icons to copy the key, copy the usage page link and close. The secret
 * lives only in the parent's state: never stored or cached, and gone on the next create, on
 * edit, on close and when the page unmounts. It can be copied again from the table.
 */
export function CreatedKeyPanel({
  apiKey,
  onDismiss,
}: {
  apiKey: string;
  onDismiss: () => void;
}): JSX.Element {
  const { t } = useT("api");
  const userPanel = useUserPanelUrl();
  return (
    <NoticeLine
      actions={
        <>
          <CopyButton
            label={t("created.copy")}
            size="icon-sm"
            value={apiKey}
            variant="tone-quiet"
          />
          <CopyButton
            icon={Link01Icon}
            label={t("created.copyUserPanel")}
            size="icon-sm"
            value={userPanel}
            variant="tone-quiet"
          />
          <NoticeIconButton icon={XIcon} label={t("created.dismiss")} onClick={onDismiss} />
        </>
      }
      data-testid="created-key-panel"
      icon={CircleCheckIcon}
      variant="success"
    >
      <span>
        {t("created.title")}{" "}
        <span className="whitespace-nowrap font-mono text-meta">{maskSecret(apiKey)}</span>
      </span>
    </NoticeLine>
  );
}
