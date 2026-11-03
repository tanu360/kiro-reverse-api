/** Card anchors in page order, with the title key the section nav shows. */
export const SETTINGS_SECTIONS = [
  { id: "settings-usage", titleKey: "usageSettings" },
  { id: "settings-stream-integrity", titleKey: "streamIntegrity" },
  { id: "settings-routing", titleKey: "routing" },
  { id: "settings-auto-continue", titleKey: "autoContinue" },
  { id: "settings-tool-history", titleKey: "toolHistory" },
  { id: "settings-thinking", titleKey: "thinkingSettings" },
  { id: "settings-model-mappings", titleKey: "modelMappings" },
  { id: "settings-endpoint", titleKey: "endpointSettings" },
  { id: "settings-admin-password", titleKey: "adminPassword" },
  { id: "settings-outbound-proxy", titleKey: "proxySettings" },
  { id: "settings-prompt-filter", titleKey: "promptFilter" },
  { id: "settings-danger-zone", titleKey: "dangerZone" },
] as const;

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
  adminPassword: "settings-admin-password",
  outboundProxy: "settings-outbound-proxy",
  promptFilter: "settings-prompt-filter",
  dangerZone: "settings-danger-zone",
} as const satisfies Record<string, SectionId>;
