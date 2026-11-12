import type { RecentRequestsParams } from "./types";

export const queryKeys = {
  status: ["status"] as const,
  version: ["version"] as const,
  remoteVersion: ["remote-version"] as const,
  firstRun: ["first-run"] as const,
  accounts: {
    all: ["accounts"] as const,
    list: () => ["accounts", "list"] as const,
    profiles: (id: string) => ["accounts", "detail", id, "profiles"] as const,
    models: (id: string) => ["accounts", "detail", id, "models"] as const,
    modelsCached: (id: string) => ["accounts", "detail", id, "models-cached"] as const,
  },
  observe: {
    all: ["observe"] as const,
    overview: () => ["observe", "overview"] as const,
    /** The default shape keeps the original 3-part key; shaped requests add their params. */
    heatmap: (
      windowMin: number,
      params?: { scope?: "global" | "all"; top?: number; bucketMin?: number },
    ) => {
      const shape = {
        ...(params?.scope === "global" ? { scope: "global" as const } : {}),
        ...(params?.top && params.top > 0 ? { top: params.top } : {}),
        ...(params?.bucketMin && params.bucketMin > 1 ? { bucketMin: params.bucketMin } : {}),
      };
      return Object.keys(shape).length > 0
        ? (["observe", "heatmap", windowMin, shape] as const)
        : (["observe", "heatmap", windowMin] as const);
    },
    modelMix: () => ["observe", "model-mix"] as const,
  },
  requests: {
    all: ["requests"] as const,
    list: (p: RecentRequestsParams) => ["requests", "list", p] as const,
    counts: () => ["requests", "counts"] as const,
  },
  apiKeys: {
    all: ["api-keys"] as const,
    list: () => ["api-keys", "list"] as const,
  },
  settings: {
    all: ["settings"] as const,
    general: () => ["settings", "general"] as const,
    thinking: () => ["settings", "thinking"] as const,
    modelMappings: () => ["settings", "model-mappings"] as const,
    endpoint: () => ["settings", "endpoint"] as const,
    proxy: () => ["settings", "proxy"] as const,
    promptFilter: () => ["settings", "prompt-filter"] as const,
    responseHeaders: () => ["settings", "response-headers"] as const,
  },
  backups: {
    all: ["backups"] as const,
    list: () => ["backups", "list"] as const,
    schedule: () => ["backups", "schedule"] as const,
  },
};
