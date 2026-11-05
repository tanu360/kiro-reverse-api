import {
  CircleCheckIcon,
  CircleSlashIcon,
  ComputerIcon,
  Globe02Icon,
} from "@hugeicons/core-free-icons";
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
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { endpointQuery, proxyQuery, settingsQuery } from "@/lib/api/settings";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { UnsavedChangesProvider, useUnsavedChanges } from "./lib/unsaved";
import { AdminPasswordCard } from "./sections/admin-password-card";
import { AutoContinueCard } from "./sections/auto-continue-card";
import { DangerZoneCard } from "./sections/danger-zone-card";
import { EndpointCard } from "./sections/endpoint-card";
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

/** Below the sticky 64 px header, with a little room: a card whose top is above this is "in view". */
const SPY_OFFSET = 96;

const GENERAL_ERROR_ID = "settings-general-error";

/** A card that failed with the shared settings query leaves only a hidden anchor. */
function isShown(element: HTMLElement): boolean {
  return !element.hidden;
}

/** Loopback addresses: only this machine can connect. */
function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/**
 * The listen address, read-only (LISTEN_HOST sets it). Green when only this machine can
 * connect; amber when every interface is open, so other machines can reach the admin panel.
 */
function ListeningOn(): JSX.Element | null {
  const { t } = useT("settings");
  const { data } = useQuery(settingsQuery());
  if (!data?.port) return null;
  const raw = data.host || "127.0.0.1";
  const local = isLoopback(raw);
  const host = raw.includes(":") ? `[${raw}]` : raw;
  return (
    <Badge
      icon={local ? ComputerIcon : Globe02Icon}
      iconStyle="line"
      tone={local ? "success" : "warning"}
      variant="soft-outline"
    >
      {local ? t("listenLocal") : t("listenOpen")}
      <span aria-hidden="true" className="opacity-40">
        ·
      </span>
      <span className="font-mono font-normal" translate="no">
        {host}:{data.port}
      </span>
    </Badge>
  );
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
    <Card className="scroll-mt-16 outline-none" id={GENERAL_ERROR_ID} tabIndex={-1}>
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
function sectionInView(): SectionId {
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
    if (element.getBoundingClientRect().top > SPY_OFFSET) break;
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
function useActiveSection(): [SectionId, (id: SectionId) => void] {
  const [active, setActive] = useState<SectionId>(SETTINGS_SECTIONS[0].id);
  // A nav click wins over the scroll event its own jump fires.
  const pinnedUntil = useRef(0);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      if (Date.now() < pinnedUntil.current) return;
      setActive(sectionInView());
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
  }, []);

  const pin = useCallback((id: SectionId) => {
    pinnedUntil.current = Date.now() + 400;
    setActive(id);
  }, []);
  return [active, pin];
}

/** Anchor links to every card: a sticky column on wide screens, a scrolling chip row below. */
function SectionNav(): JSX.Element {
  const { t } = useT("settings");
  const unsaved = useUnsavedChanges();
  const settings = useQuery(settingsQuery()).data;
  const endpoint = useQuery(endpointQuery()).data;
  const proxy = useQuery(proxyQuery()).data;
  // A section that is one switch shows its saved state as a pill in its nav row, so the page
  // reads at a glance (the cards no longer repeat a "Default: on" tag). Unknown until loaded.
  const switchState: Partial<Record<SectionId, boolean | undefined>> = {
    "settings-usage": settings?.allowOverUsage,
    "settings-stream-integrity": settings?.lenientStreamIntegrity,
    "settings-routing": settings?.sessionAffinity,
    "settings-auto-continue": settings?.autoContinue,
    "settings-tool-history": settings?.structuredToolHistory,
    "settings-endpoint": endpoint?.endpointFallback,
    "settings-outbound-proxy": proxy ? Boolean(proxy.proxyURL) : undefined,
  };
  const [active, pin] = useActiveSection();
  const listRef = useRef<HTMLDivElement>(null);

  // In the chip row, scroll the active chip into view without scrolling the page.
  useLayoutEffect(() => {
    const list = listRef.current;
    const chip = list?.querySelector<HTMLElement>(`a[href="#${active}"]`);
    if (!list || !chip || list.scrollWidth <= list.clientWidth) return;
    const listBox = list.getBoundingClientRect();
    const chipBox = chip.getBoundingClientRect();
    if (chipBox.left < listBox.left) list.scrollLeft -= listBox.left - chipBox.left + 16;
    else if (chipBox.right > listBox.right) list.scrollLeft += chipBox.right - listBox.right + 16;
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

  return (
    <nav aria-label={t("sections")} className="min-w-0 lg:sticky lg:top-20 lg:self-start">
      {/* Below lg one scrolling chip row; from lg a column of labelled groups, as the app sidebar. */}
      <div
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:-mx-6 md:px-6 lg:mx-0 lg:flex-col lg:gap-6 lg:overflow-visible lg:p-0"
        ref={listRef}
      >
        {SETTINGS_GROUPS.map((group) => {
          const labelId = `settings-nav-${group}`;
          return (
            <div className="flex shrink-0 lg:flex-col" key={group}>
              <p
                className="hidden h-7 items-center px-2.5 pb-1 font-medium text-muted-foreground text-xs lg:flex"
                id={labelId}
              >
                {t(`groups.${group}`)}
              </p>
              <ul aria-labelledby={labelId} className="flex gap-2 lg:flex-col lg:gap-1">
                {SETTINGS_SECTIONS.filter((section) => section.group === group).map((section) => {
                  const current = section.id === active;
                  const dirty = unsaved?.dirty.has(section.id) ?? false;
                  const on = switchState[section.id];
                  const danger = "tone" in section && section.tone === "danger";
                  return (
                    <li className="shrink-0" key={section.id}>
                      <a
                        aria-current={current ? "true" : undefined}
                        className={cn(
                          "group/nav inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-full border bg-background px-3 font-medium text-muted-foreground text-sm outline-none transition-colors hover:bg-accent hover:text-foreground focus-outline lg:min-h-9 lg:w-full lg:rounded-[var(--control-radius)] lg:border-transparent lg:bg-transparent lg:px-2.5 lg:pointer-coarse:min-h-10",
                          current &&
                            "border-foreground/20 bg-sidebar-row-selected text-foreground hover:bg-sidebar-row-selected hover:text-foreground active:bg-sidebar-row-selected lg:hover:bg-sidebar-row-selected lg:border-transparent lg:bg-sidebar-row-selected",
                          // Danger: red text (a light red tint when current), and a solid bright
                          // red row (red-600, as the destructive buttons) with white text on hover,
                          // press or keyboard focus, whatever the theme.
                          danger &&
                            "text-destructive-foreground hover:border-red-600 hover:bg-red-600 hover:text-white active:border-red-600 active:bg-red-600 active:text-white focus-visible:border-red-600 focus-visible:bg-red-600 focus-visible:text-white lg:hover:bg-red-600 lg:active:bg-red-600 lg:focus-visible:bg-red-600",
                          danger &&
                            current &&
                            "border-destructive/32 bg-(--pill-error-bg) text-destructive-foreground lg:bg-(--pill-error-bg)",
                        )}
                        href={`#${section.id}`}
                        onClick={(event) => onClick(event, section.id)}
                      >
                        <HugeiconsIcon
                          aria-hidden="true"
                          className={cn(
                            "size-4 shrink-0 text-muted-foreground transition-colors group-hover/nav:text-foreground",
                            current && "text-foreground",
                            danger &&
                              "text-current group-hover/nav:text-white group-active/nav:text-white group-focus-visible/nav:text-white",
                          )}
                          icon={section.icon}
                        />
                        <span className="min-w-0 flex-1 truncate">{t(section.titleKey)}</span>
                        {dirty ? (
                          <>
                            <span
                              aria-hidden="true"
                              className="size-1.5 shrink-0 rounded-full bg-warning"
                            />
                            <span className="sr-only">{t("unsavedMark")}</span>
                          </>
                        ) : null}
                        {on === undefined ? null : (
                          // Visual only: the link keeps the section name, and the card's switch
                          // announces the state.
                          <Badge
                            aria-hidden="true"
                            className="shrink-0"
                            icon={on ? CircleCheckIcon : CircleSlashIcon}
                            size="sm"
                            tone={on ? "success" : "neutral"}
                          >
                            {on ? t("stateOn") : t("stateOff")}
                          </Badge>
                        )}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
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
  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-6">
      <PageHeader meta={<ListeningOn />} title={t("title")} />
      <div className="flex min-w-0 flex-col gap-4 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
        <SectionNav />
        <div className="flex min-w-0 max-w-4xl flex-col gap-5">
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
