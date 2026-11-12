import {
  Copy01Icon,
  Delete02Icon,
  EllipsisVerticalIcon,
  FlaskConicalIcon,
  Login03Icon,
  PanelRightOpenIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX, ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { Account } from "@/lib/api/types";
import { useT } from "@/lib/i18n";
import { useDisplayEmail } from "@/lib/privacy";
import { cn } from "@/lib/utils";
import { isBanned } from "./account-model";
import { useOpenRelogin } from "./relogin-context";
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

/**
 * The admin switch, with no confirm (old UI parity). A banned or suspended account keeps a
 * switch, locked, so every row has one in the same place; its tooltip says why it is locked (the
 * server's reason when it sent one).
 */
export function EnabledSwitch({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const displayEmail = useDisplayEmail();
  const toggle = useToggleEnabled(account);
  const label = t("actions.enableAccount", { email: displayEmail(account.email, account.id) });
  if (isBanned(account)) {
    const reason =
      account.banReason ||
      t(account.banStatus === "SUSPENDED" ? "lockedSwitch.suspended" : "lockedSwitch.banned");
    return (
      <Tooltip>
        {/* The wrapper takes the hover: a disabled switch does not open a tooltip itself. */}
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Switch aria-label={label} checked={account.enabled} disabled />
        </TooltipTrigger>
        <TooltipPopup>{reason}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Switch
      aria-label={label}
      checked={account.enabled}
      disabled={toggle.isPending}
      onCheckedChange={(checked) => toggle.mutate(checked)}
    />
  );
}

/**
 * Sign in again (when the page can open it), Copy JSON, then Delete after a separator: the end of
 * every account menu.
 */
function ManageMenuItems({ account }: { account: Account }): JSX.Element {
  const { t } = useT("accounts");
  const copyJson = useCopyAccountJson();
  const remove = useDeleteAccount();
  const openRelogin = useOpenRelogin();
  return (
    <>
      {openRelogin ? (
        <MenuItem onClick={() => openRelogin(account)}>
          <HugeiconsIcon icon={Login03Icon} aria-hidden="true" />
          {t("actions.relogin")}
        </MenuItem>
      ) : null}
      <MenuItem onClick={() => void copyJson(account.id)}>
        <HugeiconsIcon icon={Copy01Icon} aria-hidden="true" />
        {t("actions.copyJson")}
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => void remove(account)} variant="destructive">
        <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
        {t("actions.delete")}
      </MenuItem>
    </>
  );
}

function IconAction({
  label,
  onClick,
  children,
  busy = false,
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
          <Button aria-label={label} loading={busy} onClick={onClick} size="icon" variant="quiet" />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Row actions. `inline` (table): Refresh token and Test buttons plus a menu with Details, Copy
 * JSON and Delete (a click on the row opens Details too). `menu` (card): every action in one
 * kebab menu.
 */
export function AccountRowActions({
  account,
  onTest,
  onDetails,
  variant = "inline",
}: RowActionHandlers & { account: Account; variant?: "inline" | "menu" }): JSX.Element {
  const { t } = useT("accounts");
  const refresh = useRefreshAccount(account.id);
  const menuItems = <ManageMenuItems account={account} />;

  if (variant === "menu") {
    return (
      <Menu>
        {/*
          Busy, not loading: a loading Button drops the click that opens the menu and is
          aria-disabled, so Test, Details, Copy JSON and Delete would wait for the refresh.
          Only the Refresh item waits.
        */}
        <MenuTrigger
          render={
            <Button
              aria-busy={refresh.isPending || undefined}
              aria-label={t("actions.more")}
              size="icon"
              variant="quiet"
            />
          }
        >
          {refresh.isPending ? (
            <Spinner aria-hidden="true" />
          ) : (
            <HugeiconsIcon icon={EllipsisVerticalIcon} aria-hidden="true" />
          )}
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            <HugeiconsIcon icon={Refresh01Icon} aria-hidden="true" />
            {t("actions.refreshToken")}
          </MenuItem>
          <MenuItem onClick={() => onTest(account)}>
            <HugeiconsIcon icon={FlaskConicalIcon} aria-hidden="true" />
            {t("actions.test")}
          </MenuItem>
          <MenuItem onClick={() => onDetails(account)}>
            <HugeiconsIcon icon={PanelRightOpenIcon} aria-hidden="true" />
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
        label={t("actions.refreshToken")}
        onClick={() => refresh.mutate()}
      >
        <HugeiconsIcon icon={Refresh01Icon} aria-hidden="true" />
      </IconAction>
      <IconAction label={t("actions.test")} onClick={() => onTest(account)}>
        <HugeiconsIcon icon={FlaskConicalIcon} aria-hidden="true" />
      </IconAction>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={<Button aria-label={t("actions.more")} size="icon" variant="quiet" />}
              />
            }
          >
            <HugeiconsIcon icon={EllipsisVerticalIcon} aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>{t("actions.more")}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end">
          <MenuItem onClick={() => onDetails(account)}>
            <HugeiconsIcon icon={PanelRightOpenIcon} aria-hidden="true" />
            {t("actions.details")}
          </MenuItem>
          {menuItems}
        </MenuPopup>
      </Menu>
    </div>
  );
}

/**
 * The detail sheet's actions, under its title: Test and Refresh token as labelled buttons, then
 * the Enabled switch and the More menu (Copy JSON, Delete) at the end, the row's own actions
 * with words. The switch's word is left out on phones, where the row needs the room; the switch
 * keeps its full name for screen readers either way.
 */
export function AccountSheetActions({
  account,
  onTest,
  className,
}: {
  account: Account;
  onTest: () => void;
  /** Layout classes only. */
  className?: string;
}): JSX.Element {
  const { t } = useT("accounts");
  const refresh = useRefreshAccount(account.id);
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <Button onClick={onTest} size="sm" variant="secondary">
        <HugeiconsIcon icon={FlaskConicalIcon} aria-hidden="true" />
        {t("actions.test")}
      </Button>
      <Button
        loading={refresh.isPending}
        onClick={() => refresh.mutate()}
        size="sm"
        variant="secondary"
      >
        <HugeiconsIcon icon={Refresh01Icon} aria-hidden="true" />
        {t("actions.refreshToken")}
      </Button>
      <div className="ms-auto flex items-center gap-2">
        <span aria-hidden="true" className="text-muted-foreground max-sm:hidden">
          {t("columns.enabled")}
        </span>
        <EnabledSwitch account={account} />
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={<Button aria-label={t("actions.more")} size="icon-sm" variant="quiet" />}
                />
              }
            >
              <HugeiconsIcon icon={EllipsisVerticalIcon} aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup>{t("actions.more")}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <ManageMenuItems account={account} />
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
