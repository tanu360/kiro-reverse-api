import {
  AiBrain01Icon,
  Alert02Icon,
  Analytics01Icon,
  ArrowDataTransferHorizontalIcon,
  CloudServerIcon,
  Coins01Icon,
  ComputerTerminal01Icon,
  Database01Icon,
  FilterHorizontalIcon,
  FirstAidKitIcon,
  GlobalIcon,
  Image01Icon,
  Location01Icon,
  LockPasswordIcon,
  NetworkIcon,
  Notification01Icon,
  RepeatIcon,
  Route02Icon,
  SecurityCheckIcon,
  ShieldKeyIcon,
  Tag01Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";

/**
 * The three Settings pages, in tab order, about seven cards each: how requests are handled, the
 * server around them, and what keeps the proxy safe (sign-in, filters, health, alerts, data).
 * Each has a `pages.<id>` label in the settings locale.
 */
export const SETTINGS_PAGES = ["requests", "server", "security"] as const;
export type SettingsPageId = (typeof SETTINGS_PAGES)[number];

/** Each page's route; the first is plain /settings, so old links land on it. */
export const SETTINGS_PAGE_PATH = {
  requests: "/settings",
  server: "/settings/server",
  security: "/settings/security",
} as const satisfies Record<SettingsPageId, string>;

/** Nav groups in page order; each has a `groups.<id>` label in the settings locale. */
export const SETTINGS_GROUPS = [
  "requests",
  "models",
  "connection",
  "monitoring",
  "signIn",
  "safety",
  "data",
] as const;
type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/** The page each nav group sits on. */
export const SETTINGS_GROUP_PAGE = {
  requests: "requests",
  models: "requests",
  connection: "server",
  monitoring: "server",
  signIn: "security",
  safety: "security",
  data: "security",
} as const satisfies Record<SettingsGroup, SettingsPageId>;

/**
 * Card anchors in page order, with the title key and icon the section nav shows. `navKey` is a
 * shorter name for the nav, where a long title would be cut beside its On/Off pill.
 */
export const SETTINGS_SECTIONS = [
  { id: "settings-usage", titleKey: "usageSettings", icon: Coins01Icon, group: "requests" },
  {
    id: "settings-stream-integrity",
    titleKey: "streamIntegrity",
    icon: SecurityCheckIcon,
    group: "requests",
  },
  { id: "settings-routing", titleKey: "routing", icon: Route02Icon, group: "requests" },
  { id: "settings-auto-continue", titleKey: "autoContinue", icon: RepeatIcon, group: "requests" },
  { id: "settings-tool-history", titleKey: "toolHistory", icon: Wrench01Icon, group: "requests" },
  { id: "settings-image-resize", titleKey: "imageResize", icon: Image01Icon, group: "requests" },
  { id: "settings-thinking", titleKey: "thinkingSettings", icon: AiBrain01Icon, group: "models" },
  {
    id: "settings-model-mappings",
    titleKey: "modelMappings",
    icon: ArrowDataTransferHorizontalIcon,
    group: "models",
  },
  {
    id: "settings-endpoint",
    titleKey: "endpointSettings",
    icon: CloudServerIcon,
    group: "connection",
  },
  {
    id: "settings-upstream",
    titleKey: "upstream.title",
    navKey: "nav.upstream",
    icon: Location01Icon,
    group: "connection",
  },
  {
    id: "settings-outbound-proxy",
    titleKey: "proxySettings",
    icon: GlobalIcon,
    group: "connection",
  },
  {
    id: "settings-proxy-pool",
    titleKey: "proxy-pool:card.title",
    icon: NetworkIcon,
    group: "connection",
  },
  {
    id: "settings-response-headers",
    titleKey: "responseHeaders",
    navKey: "nav.responseHeaders",
    icon: Tag01Icon,
    group: "connection",
  },
  {
    id: "settings-server-log",
    titleKey: "serverLog.title",
    icon: ComputerTerminal01Icon,
    group: "monitoring",
  },
  {
    id: "settings-metrics",
    titleKey: "metrics.title",
    navKey: "nav.metrics",
    icon: Analytics01Icon,
    group: "monitoring",
  },
  {
    id: "settings-admin-password",
    titleKey: "adminPassword",
    icon: LockPasswordIcon,
    group: "signIn",
  },
  {
    id: "settings-two-factor",
    titleKey: "twoFactor.title",
    navKey: "nav.twoFactor",
    icon: ShieldKeyIcon,
    group: "signIn",
  },
  {
    id: "settings-prompt-filter",
    titleKey: "promptFilter",
    navKey: "nav.promptFilter",
    icon: FilterHorizontalIcon,
    group: "safety",
  },
  { id: "settings-self-heal", titleKey: "selfHeal", icon: FirstAidKitIcon, group: "safety" },
  { id: "settings-alerts", titleKey: "alerts:title", icon: Notification01Icon, group: "safety" },
  {
    id: "settings-log-retention",
    titleKey: "logRetention",
    icon: Database01Icon,
    group: "data",
  },
  {
    id: "settings-danger-zone",
    titleKey: "dangerZone",
    icon: Alert02Icon,
    group: "data",
    // Red in the nav: red text, and a solid red row with white text on hover in both themes.
    tone: "danger",
  },
] as const satisfies readonly {
  id: string;
  titleKey: string;
  navKey?: string;
  icon: unknown;
  group: SettingsGroup;
  tone?: "danger";
}[];

export type SectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The page a card sits on. */
export function sectionPage(section: SettingsSection): SettingsPageId {
  return SETTINGS_GROUP_PAGE[section.group];
}

/** The route of the page a card sits on, for a link to it (with the card's id as the hash). */
export function sectionPagePath(id: SectionId): (typeof SETTINGS_PAGE_PATH)[SettingsPageId] {
  const section = SETTINGS_SECTIONS.find((item) => item.id === id);
  return SETTINGS_PAGE_PATH[section ? sectionPage(section) : "requests"];
}

const PAGE_SECTIONS: Record<SettingsPageId, readonly SettingsSection[]> = {
  requests: SETTINGS_SECTIONS.filter((section) => sectionPage(section) === "requests"),
  server: SETTINGS_SECTIONS.filter((section) => sectionPage(section) === "server"),
  security: SETTINGS_SECTIONS.filter((section) => sectionPage(section) === "security"),
};

/** The cards of one page, in page order: the same array on every call, safe as a hook input. */
export function pageSections(page: SettingsPageId): readonly SettingsSection[] {
  return PAGE_SECTIONS[page];
}

/** The card a hash names ("settings-alerts" or "#settings-alerts"), or undefined. */
export function findSection(hash: string): SettingsSection | undefined {
  const id = hash.replace(/^#/, "");
  return SETTINGS_SECTIONS.find((section) => section.id === id);
}

export const SECTION_ID = {
  usage: "settings-usage",
  streamIntegrity: "settings-stream-integrity",
  routing: "settings-routing",
  autoContinue: "settings-auto-continue",
  toolHistory: "settings-tool-history",
  imageResize: "settings-image-resize",
  selfHeal: "settings-self-heal",
  thinking: "settings-thinking",
  modelMappings: "settings-model-mappings",
  endpoint: "settings-endpoint",
  upstream: "settings-upstream",
  adminPassword: "settings-admin-password",
  twoFactor: "settings-two-factor",
  outboundProxy: "settings-outbound-proxy",
  proxyPool: "settings-proxy-pool",
  responseHeaders: "settings-response-headers",
  alerts: "settings-alerts",
  serverLog: "settings-server-log",
  metrics: "settings-metrics",
  promptFilter: "settings-prompt-filter",
  logRetention: "settings-log-retention",
  dangerZone: "settings-danger-zone",
} as const satisfies Record<string, SectionId>;
