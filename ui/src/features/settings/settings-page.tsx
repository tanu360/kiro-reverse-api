import { CircleCheckIcon, CircleSlashIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import {
  type JSX,
  type MouseEvent,
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
import { useMediaQuery } from "@/hooks/use-media-query";
import { proxyQuery, settingsQuery } from "@/lib/api/settings";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { UnsavedChangesProvider, useUnsavedChanges } from "./lib/unsaved";
import { AdminPasswordCard } from "./sections/admin-password-card";
import { AutoContinueCard } from "./sections/auto-continue-card";
import { DangerZoneCard } from "./sections/danger-zone-card";
import { EndpointCard } from "./sections/endpoint-card";
import { LogRetentionCard } from "./sections/log-retention-card";
import { ModelMappingsCard } from "./sections/model-mappings-card";
import { OutboundProxyCard } from "./sections/outbound-proxy-card";
import { PromptFilterCard } from "./sections/prompt-filter-card";
import { RoutingCard } from "./sections/routing-card";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS } from "./sections/sections";
import { StreamIntegrityCard } from "./sections/stream-integrity-card";
import { ThinkingCard } from "./sections/thinking-card";
import { ToolHistoryCard } from "./sections/tool-history-card";
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

/** Scroll-spy: the card in view, updated once per frame while the page scrolls. */
function useActiveSection(offset: number): [SectionId, (id: SectionId) => void] {
  const [active, setActive] = useState<SectionId>(SETTINGS_SECTIONS[0].id);
  // A nav click wins over the scroll event its own jump fires.
  const pinnedUntil = useRef(0);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      if (Date.now() < pinnedUntil.current) return;
      setActive(sectionInView(offset));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [offset]);

  const pin = useCallback((id: SectionId) => {
    pinnedUntil.current = Date.now() + 400;
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
  // A section that is one switch shows its saved state as a pill in its nav row, so the page
  // reads at a glance (the cards no longer repeat a "Default: on" tag). Unknown until loaded.
  const switchState: Partial<Record<SectionId, boolean | undefined>> = {
    "settings-usage": settings?.allowOverUsage,
    "settings-stream-integrity": settings?.lenientStreamIntegrity,
    "settings-routing": settings?.sessionAffinity,
    "settings-auto-continue": settings?.autoContinue,
    "settings-tool-history": settings?.structuredToolHistory,
    "settings-outbound-proxy": proxy ? Boolean(proxy.proxyURL) : undefined,
  };
  const [active, pin] = useActiveSection(wide ? SPY_OFFSET : SPY_OFFSET + CHIP_ROW_HEIGHT);
  const listRef = useRef<HTMLDivElement>(null);

  // In the chip row, scroll the active chip into view without scrolling the page.
  useLayoutEffect(() => {
    const list = listRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const chip = listRef.current?.querySelector<HTMLElement>(`a[href="#${active}"]`);
    if (!list || !chip || list.scrollWidth <= list.clientWidth) return;
    const listBox = list.getBoundingClientRect();
    const chipBox = chip.getBoundingClientRect();
    if (chipBox.left < listBox.left) list.scrollLeft -= listBox.left - chipBox.left + 32;
    else if (chipBox.right > listBox.right) list.scrollLeft += chipBox.right - listBox.right + 32;
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
                  <SidebarMenuButton
                    isActive={entry.current}
                    render={
                      <a
                        aria-current={entry.current ? "true" : undefined}
                        href={`#${entry.id}`}
                        onClick={(event) => onClick(event, entry.id)}
                      />
                    }
                    variant={entry.danger ? "destructive" : "default"}
                  >
                    <HugeiconsIcon aria-hidden="true" icon={entry.icon} />
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    {entry.dirty ? <DirtyMark /> : null}
                    {/* In the row's own flex line, so the label truncates before a pill of any width. */}
                    {entry.on === undefined ? null : (
                      <span className="flex shrink-0">
                        <StateBadge on={entry.on} />
                      </span>
                    )}
                  </SidebarMenuButton>
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

function SettingsContent(): JSX.Element {
  const { t } = useT("settings");
  useLeaveGuard();
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
        <div className="flex min-w-0 max-w-5xl flex-col gap-4 md:gap-6 2xl:max-w-6xl">
          <GeneralSettingsError />
          <UsageCard />
          <StreamIntegrityCard />
          <RoutingCard />
          <AutoContinueCard />
          <ToolHistoryCard />
          <ThinkingCard />
          <ModelMappingsCard />
          <EndpointCard />
          <AdminPasswordCard />
          <OutboundProxyCard />
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
