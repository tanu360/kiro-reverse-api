import {
  Delete02Icon,
  KeyRoundIcon,
  SquareUnlock02Icon,
  UnavailableIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useCallback } from "react";
import type { ApiKeyUsageKind } from "@/lib/api/api-key-usage";
import { useT } from "@/lib/i18n";
import { useMaskText } from "@/lib/privacy";

/** What names a usage row: enough of an entry to label it before or without its data. */
export interface UsageIdentity {
  kind: ApiKeyUsageKind;
  name?: string;
  keyMasked?: string;
}

export interface UsageLabel {
  /** The key's name (emails masked in privacy mode), or the group's name. */
  title: string;
  /** False for an unnamed key: its title is the placeholder, its masked key says more. */
  named: boolean;
  /** The masked key, in mono; empty for the groups. */
  keyMasked: string;
  /** A line about a group that has no key to show. */
  hint: string;
  icon: IconSvgElement;
  /** Not a configured key: no API key, invalid keys or a deleted key. */
  group: boolean;
}

/**
 * Labels for usage rows: a key by its name (a name can hold an email, so it goes through the
 * privacy mask), the groups by what they are. Never more of a key than its masked form.
 */
export function useUsageLabel(): (identity: UsageIdentity) => UsageLabel {
  const { t } = useT("api");
  const maskText = useMaskText();
  return useCallback(
    (identity: UsageIdentity): UsageLabel => {
      const keyMasked = identity.keyMasked ?? "";
      switch (identity.kind) {
        case "none":
          return {
            title: t("usage.noKey"),
            named: true,
            keyMasked: "",
            hint: t("usage.noKeyHint"),
            icon: SquareUnlock02Icon,
            group: true,
          };
        case "invalid":
          return {
            title: t("usage.invalidKey"),
            named: true,
            keyMasked: "",
            hint: t("usage.invalidKeyHint"),
            icon: UnavailableIcon,
            group: true,
          };
        case "deleted":
          return {
            title: t("usage.deletedKey"),
            named: true,
            keyMasked,
            hint: t("usage.deletedKeyHint"),
            icon: Delete02Icon,
            group: true,
          };
        default:
          return {
            title: identity.name ? maskText(identity.name) : t("keys.unnamed"),
            named: Boolean(identity.name),
            keyMasked,
            hint: "",
            icon: KeyRoundIcon,
            group: false,
          };
      }
    },
    [t, maskText],
  );
}
