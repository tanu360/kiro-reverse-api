import { CircleCheckIcon, CircleSlashIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import {
  type JSX,
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader } from "@/components/shared/page-header";
import { StatusDot } from "@/components/shared/status-dot";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { ProxyPoolCard } from "@/features/proxy-pool/proxy-pool-card";
import { useMediaQuery } from "@/hooks/use-media-query";
import { accountHealthQuery } from "@/lib/api/account-health";
import { alertsQuery } from "@/lib/api/alerts";
import { metricsQuery } from "@/lib/api/metrics";
import { proxyPoolQuery } from "@/lib/api/proxy-pool";
import { responseHeadersQuery } from "@/lib/api/response-headers";
import { promptFilterQuery, proxyQuery, settingsQuery } from "@/lib/api/settings";
import { twoFactorQuery } from "@/lib/api/two-factor";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { UnsavedChangesProvider, useUnsavedChanges } from "./lib/unsaved";
import { AdminPasswordCard } from "./sections/admin-password-card";
import { AlertsCard } from "./sections/alerts-card";
import { AutoContinueCard } from "./sections/auto-continue-card";
import { DangerZoneCard } from "./sections/danger-zone-card";
import { EndpointCard } from "./sections/endpoint-card";
import { ImageResizeCard } from "./sections/image-resize-card";
import { LogRetentionCard } from "./sections/log-retention-card";
import { MetricsCard } from "./sections/metrics-card";
import { ModelMappingsCard } from "./sections/model-mappings-card";
import { OutboundProxyCard } from "./sections/outbound-proxy-card";
import { PromptFilterCard } from "./sections/prompt-filter-card";
import { ResponseHeadersCard } from "./sections/response-headers-card";
import { RoutingCard } from "./sections/routing-card";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS } from "./sections/sections";
import { SelfHealCard } from "./sections/self-heal-card";
import { ServerLogCard } from "./sections/server-log-card";
import { StreamIntegrityCard } from "./sections/stream-integrity-card";
import { ThinkingCard } from "./sections/thinking-card";
import { ToolHistoryCard } from "./sections/tool-history-card";
import { TwoFactorCard } from "./sections/two-factor-card";
import { UpstreamCard } from "./sections/upstream-card";
import { UsageCard } from "./sections/usage-card";

type SectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/**
 * Below the sticky 48 px header, with a little room: a card whose top is above this is "in
 * view". Below xl the sticky chip row (about 56 px) sits under the header too.
 */
const SPY_OFFSET = 96;
const CHIP_ROW_HEIGHT = 56;

const GENERAL_ERROR_ID = "settings-general-error";

/** A card that failed with the shared settings query leaves only a hidden anchor. */
function isShown(element: HTMLElement): boolean {
  return !element.hidden;
}

/**
 * One error for the five cards built on GET /settings, instead of one per card. Cards with
 * their own endpoint (thinking, model mapping, endpoint, proxy, prompt filter) keep theirs.
 */
function GeneralSettingsError(): JSX.Element | null {
  const { t } = useT("settings");
  const query = useQuery(settingsQuery());
  if (!query.isError) return null;
  return (
    <Card
      className="scroll-mt-20 outline-none max-xl:scroll-mt-30"
      id={GENERAL_ERROR_ID}
      tabIndex={-1}
    >
      <ErrorState
        compact
        error={query.error}
        onRetry={() => void query.refetch()}
        title={t("loadFailed")}
      />
    </Card>
  );
}

/** The last card whose top has scrolled under the header; the last card at the page bottom. */
function sectionInView(offset: number): SectionId {
  const root = document.documentElement;
  if (
    root.scrollHeight > window.innerHeight &&
    window.scrollY + window.innerHeight >= root.scrollHeight - 2
  ) {
    return SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1].id;
  }
  let current: SectionId = SETTINGS_SECTIONS[0].id;
  for (const section of SETTINGS_SECTIONS) {
    const element = document.getElementById(section.id);
    if (!element || !isShown(element)) continue;
    if (element.getBoundingClientRect().top > offset) break;
    current = section.id;
  }
  return current;
}

/** Scrolls to a card and moves focus to its heading, so the next Tab goes into the card. */
function goToSection(id: SectionId): void {
  const anchor = document.getElementById(id);
  // A card hidden by the shared load error sends you to that error instead.
  const card = anchor && !isShown(anchor) ? document.getElementById(GENERAL_ERROR_ID) : anchor;
  if (!card) return;
  card.scrollIntoView({ block: "start" });
  // A loading or failed card has no heading yet; its placeholder takes focus instead.
  const target = document.getElementById(`${id}-title`) ?? card;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

/** The section a deep link names (/settings#settings-alerts), or null. */
function hashSection(): SectionId | null {
  const id = window.location.hash.slice(1);
  return SETTINGS_SECTIONS.find((section) => section.id === id)?.id ?? null;
}

/** Keys that scroll the page while focus is not in a text field. */
const SCROLL_KEYS = new Set([" ", "PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]);

/** How long after a wheel, touch or scroll key a page scroll counts as the reader's. */
const USER_SCROLL_MS = 800;

function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/**
 * Scroll-spy: the card in view, updated once per frame while the page scrolls. A nav click or a
 * deep link keeps its section marked until the reader scrolls the page (a scroll that follows a
 * wheel, touch or scroll key; the page shows no vertical scrollbar, index.css) or tabs into
 * another card. Near the page end the card it went to sits at the top while the page cannot
 * scroll further, where the spy alone marks the last card. A key that only works a control
 * (Space on a switch) does not scroll, so the section stays marked.
 */
function useActiveSection(offset: number): [SectionId, (id: SectionId) => void] {
  const [linked] = useState(hashSection);
  const [active, setActive] = useState<SectionId>(linked ?? SETTINGS_SECTIONS[0].id);
  const pinned = useRef<SectionId | null>(linked);
  const userUntil = useRef(0);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setActive(pinned.current ?? sectionInView(offset));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onScroll = () => {
      if (pinned.current && performance.now() < userUntil.current) pinned.current = null;
      schedule();
    };
    const userInput = () => {
      userUntil.current = performance.now() + USER_SCROLL_MS;
    };
    const onKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key) && !isTextField(event.target)) userInput();
    };
    // Tabbing on into another card moves the reader there, so the spy follows again.
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!pinned.current || !(target instanceof Element) || target.closest("nav")) return;
      if (document.getElementById(pinned.current)?.contains(target)) return;
      pinned.current = null;
      schedule();
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("wheel", userInput, { passive: true });
    window.addEventListener("touchmove", userInput, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("focusin", onFocus);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("wheel", userInput);
      window.removeEventListener("touchmove", userInput);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focusin", onFocus);
    };
  }, [offset]);

  // A tap on a chip can follow a touch that moved the chip row: the jump it starts is not the
  // reader's scroll.
  const pin = useCallback((id: SectionId) => {
    pinned.current = id;
    userUntil.current = 0;
    setActive(id);
  }, []);
  return [active, pin];
}

/*
 * A chip of the phone and tablet nav row. The nav is page navigation, not a control kit part,
 * so its chip look lives here, in theme tokens only: a hairline pill, the surface step and a
 * firmer edge for the current section, red text and a red tint for the danger zone.
 */
const CHIP_CLASS =
  "inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-full border border-border bg-card px-3 font-medium text-muted-foreground text-sm outline-none transition-colors hover:bg-accent hover:text-foreground focus-outline aria-current:border-border-strong aria-current:bg-surface-2 aria-current:text-foreground sm:min-h-9 pointer-coarse:min-h-10 [&_svg]:size-4 [&_svg]:shrink-0";
const DANGER_CHIP_CLASS =
  "text-destructive-foreground hover:bg-error-surface hover:text-destructive-foreground aria-current:border-destructive/32 aria-current:bg-error-surface aria-current:text-destructive-foreground";

interface NavEntry {
  id: SectionId;
  label: string;
  icon: (typeof SETTINGS_SECTIONS)[number]["icon"];
  current: boolean;
  dirty: boolean;
  /** The saved state of a one-switch section; undefined for the others and until loaded. */
  on: boolean | undefined;
  danger: boolean;
}

/**
 * One wide-nav row: the app sidebar's row as a link to its section. A name cut beside its pill
 * (pt-BR "Integridade do stream") shows whole in a tooltip while it is cut, on hover and when
 * the keyboard focuses the link (the link is the tooltip's trigger, not the name inside it).
 */
function WideNavLink({
  entry,
  onClick,
}: {
  entry: NavEntry;
  onClick: (event: MouseEvent<HTMLAnchorElement>, id: SectionId) => void;
}): JSX.Element {
  const label = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      onOpenChange={(next) => {
        const element = label.current;
        setOpen(next && element !== null && element.scrollWidth > element.clientWidth);
      }}
      open={open}
    >
      <SidebarMenuButton
        isActive={entry.current}
        render={
          <TooltipTrigger
            render={
              <a
                aria-current={entry.current ? "true" : undefined}
                href={`#${entry.id}`}
                onClick={(event) => onClick(event, entry.id)}
              />
            }
          />
        }
        variant={entry.danger ? "destructive" : "default"}
      >
        <HugeiconsIcon aria-hidden="true" icon={entry.icon} />
        <span className="block min-w-0 flex-1 truncate" ref={label}>
          {entry.label}
        </span>
        {entry.dirty ? <DirtyMark /> : null}
        {/* In the row's own flex line, so the label truncates before a pill of any width. */}
        {entry.on === undefined ? null : (
          <span className="flex shrink-0">
            <StateBadge on={entry.on} />
          </span>
        )}
      </SidebarMenuButton>
      <TooltipPopup>{entry.label}</TooltipPopup>
    </Tooltip>
  );
}

/** The section's saved On/Off, visual only: the link keeps the section name. */
function StateBadge({ on }: { on: boolean }): JSX.Element {
  const { t } = useT("settings");
  return (
    <Badge
      aria-hidden="true"
      icon={on ? CircleCheckIcon : CircleSlashIcon}
      size="sm"
      tone={on ? "success" : "neutral"}
    >
      {on ? t("stateOn") : t("stateOff")}
    </Badge>
  );
}

/** A warning dot for a card with unsaved edits, named for screen readers in the link. */
function DirtyMark(): JSX.Element {
  const { t } = useT("settings");
  return (
    <>
      <StatusDot size="sm" tone="warning" />
      <span className="sr-only">{t("unsavedMark")}</span>
    </>
  );
}

/** Anchor links to every card: a sticky sidebar column from xl, a sticky chip row below it. */
function SectionNav({ wide }: { wide: boolean }): JSX.Element {
  const { t } = useT("settings");
  const unsaved = useUnsavedChanges();
  const settings = useQuery(settingsQuery()).data;
  const proxy = useQuery(proxyQuery()).data;
  const proxyPool = useQuery(proxyPoolQuery()).data;
  const health = useQuery(accountHealthQuery()).data;
  const alerts = useQuery(alertsQuery()).data;
  const headers = useQuery(responseHeadersQuery()).data;
  const promptFilter = useQuery(promptFilterQuery()).data;
  const twoFactor = useQuery(twoFactorQuery()).data;
  const metrics = useQuery(metricsQuery()).data;
  // A section that is one switch shows its saved state as a pill in its nav row, so the page
  // reads at a glance (the cards no longer repeat a "Default: on" tag). Unknown until loaded.
  // A card of several controls shows On when it does anything: alerts with a channel switched
  // on, a custom header sent, a prompt filter or rule at work.
  const switchState: Partial<Record<SectionId, boolean | undefined>> = {
    "settings-usage": settings?.allowOverUsage,
    "settings-stream-integrity": settings?.lenientStreamIntegrity,
    "settings-auto-continue": settings?.autoContinue,
    "settings-tool-history": settings?.structuredToolHistory,
    "settings-image-resize": settings ? settings.imageResize !== false : undefined,
    "settings-outbound-proxy": proxy ? Boolean(proxy.proxyURL) : undefined,
    "settings-proxy-pool": proxyPool ? proxyPool.mode === "on" : undefined,
    "settings-self-heal": health?.enabled,
    "settings-two-factor": twoFactor?.enabled,
    "settings-metrics": metrics?.enabled,
    "settings-alerts": alerts ? alerts.channels.some((channel) => channel.enabled) : undefined,
    "settings-response-headers": headers
      ? headers.headers.some((header) => header.enabled)
      : undefined,
    "settings-prompt-filter": promptFilter
      ? promptFilter.filterClaudeCode ||
        promptFilter.filterEnvNoise ||
        promptFilter.rules.some((rule) => rule.enabled)
      : undefined,
  };
  const [active, pin] = useActiveSection(wide ? SPY_OFFSET : SPY_OFFSET + CHIP_ROW_HEIGHT);
  const listRef = useRef<HTMLDivElement>(null);

  // In the chip row, scroll the active chip into view without scrolling the page: when the
  // section changes, and when the chips change width (their On/Off pills load after a deep link
  // has landed and pushed the active chip back out of view).
  useLayoutEffect(() => {
    const row = listRef.current;
    const list = row?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!row || !list) return;
    const reveal = () => {
      const chip = row.querySelector<HTMLElement>(`a[href="#${active}"]`);
      if (!chip || list.scrollWidth <= list.clientWidth) return;
      const listBox = list.getBoundingClientRect();
      const chipBox = chip.getBoundingClientRect();
      if (chipBox.left < listBox.left) list.scrollLeft -= listBox.left - chipBox.left + 32;
      else if (chipBox.right > listBox.right) list.scrollLeft += chipBox.right - listBox.right + 32;
    };
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(row);
    return () => observer.disconnect();
  }, [active]);

  const onClick = (event: MouseEvent<HTMLAnchorElement>, id: SectionId) => {
    // A modified click keeps the browser's own behaviour (new tab, new window).
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    pin(id);
    goToSection(id);
  };

  const groups = SETTINGS_GROUPS.map((group) => ({
    group,
    labelId: `settings-nav-${group}`,
    entries: SETTINGS_SECTIONS.filter((section) => section.group === group).map(
      (section): NavEntry => ({
        id: section.id,
        label: t(section.titleKey),
        icon: section.icon,
        current: section.id === active,
        dirty: unsaved?.dirty.has(section.id) ?? false,
        on: switchState[section.id],
        danger: "tone" in section && section.tone === "danger",
      }),
    ),
  }));

  if (wide) {
    // From xl: the app sidebar's own rows, one labelled group per nav group.
    return (
      <nav aria-label={t("sections")} className="sticky top-20 flex flex-col gap-4 self-start">
        {groups.map(({ group, labelId, entries }) => (
          <SidebarGroup className="p-0" key={group}>
            <SidebarGroupLabel id={labelId}>{t(`groups.${group}`)}</SidebarGroupLabel>
            <SidebarMenu aria-labelledby={labelId}>
              {entries.map((entry) => (
                <SidebarMenuItem key={entry.id}>
                  <WideNavLink entry={entry} onClick={onClick} />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </nav>
    );
  }

  // Below xl: one sticky chip row under the header, bleeding to the page edges; its ends fade
  // while there are more chips past them. It covers the shell's top scroll fade, so it carries
  // its own below it, as tall as the 16 px gap to the first card.
  return (
    <nav
      aria-label={t("sections")}
      className="sticky top-12 z-30 -mx-4 bg-background pt-1 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-4 after:bg-linear-to-b after:from-background md:-mx-6"
    >
      <ScrollArea className="h-auto" clampContentMinWidth={false} scrollFade scrollbarGutter>
        {/* The top 4px of padding sits inside the scroller, so a chip's focus ring is not clipped. */}
        <div className="flex w-max gap-2 px-4 pt-1 md:px-6" ref={listRef}>
          {groups.map(({ group, labelId, entries }) => (
            <div className="flex shrink-0" key={group}>
              <p className="sr-only" id={labelId}>
                {t(`groups.${group}`)}
              </p>
              <ul aria-labelledby={labelId} className="flex gap-2">
                {entries.map((entry) => (
                  <li className="shrink-0" key={entry.id}>
                    <a
                      aria-current={entry.current ? "true" : undefined}
                      className={cn(CHIP_CLASS, entry.danger && DANGER_CHIP_CLASS)}
                      href={`#${entry.id}`}
                      onClick={(event) => onClick(event, entry.id)}
                    >
                      <HugeiconsIcon aria-hidden="true" icon={entry.icon} />
                      {entry.label}
                      {entry.dirty ? <DirtyMark /> : null}
                      {entry.on === undefined ? null : <StateBadge on={entry.on} />}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </ScrollArea>
    </nav>
  );
}

/** Asks before a route change drops unsaved edits; the browser asks on reload or tab close. */
function useLeaveGuard(): void {
  const { t } = useT("settings");
  const confirm = useConfirm();
  const unsaved = useUnsavedChanges();
  const isDirty = unsaved?.isDirty ?? (() => false);
  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      // Section jumps stay on the page; sign-out and an expired session must always leave.
      if (!isDirty() || current.pathname === next.pathname) return false;
      if (/\/(login|setup)\/?$/.test(next.pathname)) return false;
      const discard = await confirm({
        title: t("discardTitle"),
        description: t("discardBody"),
        confirmLabel: t("discardAction"),
        cancelLabel: t("keepEditing"),
        variant: "danger",
      });
      return !discard;
    },
    enableBeforeUnload: isDirty,
  });
}

/**
 * A deep link (/settings#settings-alerts) on a fresh load lands while the cards above its card
 * still load and grow, so it ends up far above it. Until the reader scrolls, presses a key or a
 * few seconds pass, every growth of the column brings the card back to the top. The column that
 * holds every card is watched, not the card's parent: a card wrapped in its own form (the admin
 * password) has a parent that never grows while the cards above it load.
 */
function useHashLanding(columnRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    const column = columnRef.current;
    if (!SETTINGS_SECTIONS.some((section) => section.id === id) || !column) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    });
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      for (const type of events) window.removeEventListener(type, stop);
    };
    const timer = window.setTimeout(stop, 5000);
    for (const type of events) window.addEventListener(type, stop, { passive: true });
    observer.observe(column);
    return stop;
  }, [columnRef]);
}

function SettingsContent(): JSX.Element {
  const { t } = useT("settings");
  useLeaveGuard();
  const columnRef = useRef<HTMLDivElement>(null);
  useHashLanding(columnRef);
  // The nav becomes a column only from xl: at lg the app sidebar is already open, and a third
  // column would leave the cards too narrow for their rows.
  const wide = useMediaQuery("xl");
  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-6">
      <PageHeader description={t("description")} title={t("title")} />
      <div className="flex min-w-0 flex-col gap-4 xl:grid xl:grid-cols-[14rem_minmax(0,1fr)] xl:gap-10">
        <SectionNav wide={wide} />
        {/* Capped, so on a wide screen a row's control stays near its label; a little wider
            from 2xl, so the column does not leave an empty band on the right only. */}
        <div
          className="flex min-w-0 max-w-5xl flex-col gap-4 md:gap-6 2xl:max-w-6xl"
          ref={columnRef}
        >
          <GeneralSettingsError />
          <UsageCard />
          <StreamIntegrityCard />
          <RoutingCard />
          <AutoContinueCard />
          <ToolHistoryCard />
          <ImageResizeCard />
          <SelfHealCard />
          <ThinkingCard />
          <ModelMappingsCard />
          <EndpointCard />
          <UpstreamCard />
          <AdminPasswordCard />
          <TwoFactorCard />
          <OutboundProxyCard />
          <ProxyPoolCard />
          <ResponseHeadersCard />
          <AlertsCard />
          <ServerLogCard />
          <MetricsCard />
          <PromptFilterCard />
          <LogRetentionCard />
          <DangerZoneCard />
        </div>
      </div>
    </div>
  );
}

export function SettingsPage(): JSX.Element {
  return (
    <UnsavedChangesProvider>
      <SettingsContent />
    </UnsavedChangesProvider>
  );
}
