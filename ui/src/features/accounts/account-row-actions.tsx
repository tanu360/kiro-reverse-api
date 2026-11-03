import {
  CopyIcon,
  EllipsisVerticalIcon,
  FlaskConicalIcon,
  PanelRightOpenIcon,
  RotateCwIcon,
  Trash2Icon,
} from "lucide-react";
import type { JSX, ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { isBanned } from "./account-model";
import {
  useCopyAccountJson,
  useDeleteAccount,
  useRefreshAccount,
  useToggleEnabled,
} from "./use-account-actions";

export interface RowActionHandlers {
  onTest: (account: Account) => void;
  onDetails: (account: Account) => void;
}

/** The admin switch. Hidden for banned accounts; no confirm (old UI parity). */
export function EnabledSwitch({ account }: { account: Account }): JSX.Element | null {
  const { t } = useT("accounts");
  const displayEmail = useDisplayEmail();
  const toggle = useToggleEnabled(account);
  if (isBanned(account)) return null;
  return (
    <Switch
      aria-label={t("actions.enableAccount", { email: displayEmail(account.email, account.id) })}
      checked={account.enabled}
      // Grows the hit area 10 px on each side: 58x42 around the 38x22 phone track.
      className="relative after:absolute after:-inset-2.5"
      disabled={toggle.isPending}
      onCheckedChange={(checked) => toggle.mutate(checked)}
    />
  );
}

function IconAction({
  label,
  onClick,
  children,
  busy,
}: {
  label: string;
  onClick: () => void;
  children: ReactElement;
  busy?: boolean;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-busy={busy || undefined}
            aria-label={label}
            className="size-10 md:size-8"
            disabled={busy}
            onClick={onClick}
            size="icon"
            variant="ghost"
          />
        }
      >
        {busy ? <Spinner aria-hidden="true" /> : children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Row actions. `inline` (table): Refresh, Test, Details buttons plus a menu with Copy JSON and
 * Delete. `menu` (mobile card): every action in one kebab menu.
 */
export function AccountRowActions({
  account,
  onTest,
  onDetails,
  variant = "inline",
}: RowActionHandlers & { account: Account; variant?: "inline" | "menu" }): JSX.Element {
  const { t } = useT("accounts");
  const refresh = useRefreshAccount(account.id);
  const copyJson = useCopyAccountJson();
  const remove = useDeleteAccount();

  // Menu rows are 40 px tall in the mobile kebab menu (touch targets).
  const itemClass = variant === "menu" ? "min-h-10" : undefined;
  const menuItems = (
    <>
      <MenuItem className={itemClass} onClick={() => void copyJson(account.id)}>
        <CopyIcon aria-hidden="true" />
        {t("actions.copyJson")}
      </MenuItem>
      <MenuSeparator />
      <MenuItem className={itemClass} onClick={() => void remove(account.id)} variant="destructive">
        <Trash2Icon aria-hidden="true" />
        {t("actions.delete")}
      </MenuItem>
    </>
  );

  if (variant === "menu") {
    return (
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-busy={refresh.isPending || undefined}
              aria-label={t("actions.more")}
              className="size-10"
              size="icon"
              variant="ghost"
            />
          }
        >
          {refresh.isPending ? (
            <Spinner aria-hidden="true" />
          ) : (
            <EllipsisVerticalIcon aria-hidden="true" />
          )}
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem
            className={itemClass}
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RotateCwIcon aria-hidden="true" />
            {t("actions.refresh")}
          </MenuItem>
          <MenuItem className={itemClass} onClick={() => onTest(account)}>
            <FlaskConicalIcon aria-hidden="true" />
            {t("actions.test")}
          </MenuItem>
          <MenuItem className={itemClass} onClick={() => onDetails(account)}>
            <PanelRightOpenIcon aria-hidden="true" />
            {t("actions.details")}
          </MenuItem>
          {menuItems}
        </MenuPopup>
      </Menu>
    );
  }

  return (
    <div className="flex items-center justify-end gap-0.5">
      <IconAction
        busy={refresh.isPending}
        label={t("actions.refresh")}
        onClick={() => refresh.mutate()}
      >
        <RotateCwIcon aria-hidden="true" />
      </IconAction>
      <IconAction label={t("actions.test")} onClick={() => onTest(account)}>
        <FlaskConicalIcon aria-hidden="true" />
      </IconAction>
      <IconAction label={t("actions.details")} onClick={() => onDetails(account)}>
        <PanelRightOpenIcon aria-hidden="true" />
      </IconAction>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    aria-label={t("actions.more")}
                    className="size-10 md:size-8"
                    size="icon"
                    variant="ghost"
                  />
                }
              />
            }
          >
            <EllipsisVerticalIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>{t("actions.more")}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end">{menuItems}</MenuPopup>
      </Menu>
    </div>
  );
}
