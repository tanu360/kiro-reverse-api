import {
  AiBrain01Icon,
  Alert02Icon,
  ArrowDataTransferHorizontalIcon,
  CloudServerIcon,
  Coins01Icon,
  FilterHorizontalIcon,
  GlobalIcon,
  Location01Icon,
  LockPasswordIcon,
  RepeatIcon,
  Route02Icon,
  SecurityCheckIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";

/** Nav groups in page order; each has a `groups.<id>` label in the settings locale. */
export const SETTINGS_GROUPS = ["requests", "models", "server", "safety"] as const;

/** Card anchors in page order, with the title key and icon the section nav shows. */
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
  { id: "settings-thinking", titleKey: "thinkingSettings", icon: AiBrain01Icon, group: "models" },
  {
    id: "settings-model-mappings",
    titleKey: "modelMappings",
    icon: ArrowDataTransferHorizontalIcon,
    group: "models",
  },
  { id: "settings-endpoint", titleKey: "endpointSettings", icon: CloudServerIcon, group: "server" },
  { id: "settings-upstream", titleKey: "upstream.title", icon: Location01Icon, group: "server" },
  {
    id: "settings-admin-password",
    titleKey: "adminPassword",
    icon: LockPasswordIcon,
    group: "server",
  },
  { id: "settings-outbound-proxy", titleKey: "proxySettings", icon: GlobalIcon, group: "server" },
  {
    id: "settings-prompt-filter",
    titleKey: "promptFilter",
    icon: FilterHorizontalIcon,
    group: "safety",
  },
  {
    id: "settings-danger-zone",
    titleKey: "dangerZone",
    icon: Alert02Icon,
    group: "safety",
    // Red in the nav: red text, and a solid red row with white text on hover in both themes.
    tone: "danger",
  },
] as const satisfies readonly {
  id: string;
  titleKey: string;
  icon: unknown;
  group: (typeof SETTINGS_GROUPS)[number];
  tone?: "danger";
}[];

type SectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const SECTION_ID = {
  usage: "settings-usage",
  streamIntegrity: "settings-stream-integrity",
  routing: "settings-routing",
  autoContinue: "settings-auto-continue",
  toolHistory: "settings-tool-history",
  thinking: "settings-thinking",
  modelMappings: "settings-model-mappings",
  endpoint: "settings-endpoint",
  upstream: "settings-upstream",
  adminPassword: "settings-admin-password",
  outboundProxy: "settings-outbound-proxy",
  promptFilter: "settings-prompt-filter",
  dangerZone: "settings-danger-zone",
} as const satisfies Record<string, SectionId>;
