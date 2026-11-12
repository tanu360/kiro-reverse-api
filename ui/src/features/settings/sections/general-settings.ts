import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { queryKeys } from "@/lib/api/query-keys";
import { updateSettings } from "@/lib/api/settings";
import type { Settings, SettingsPatch } from "@/lib/api/types";
import type { Draft } from "../lib/dirty";
import { useSectionSave } from "./settings-section";

/**
 * Saves one card's slice of GET /settings. POST /settings is a non-atomic patch, so the card
 * sends only its own fields. On success the slice is written into the cached settings before
 * the refetch, so the other cards and this one agree at once.
 */
export function useGeneralSettingsSave<D>(draft: Draft<D>): {
  save: (patch: D & SettingsPatch) => void;
  saving: boolean;
} {
  const queryClient = useQueryClient();
  return useSectionSave((patch: D & SettingsPatch) => updateSettings(patch), {
    onSaved: (patch) => {
      draft.commit(patch);
      writeSettingsCache(queryClient, patch);
    },
  });
}

/** Writes a saved slice into the cached settings, then refetches them. */
export function writeSettingsCache(
  queryClient: ReturnType<typeof useQueryClient>,
  patch: SettingsPatch,
): void {
  queryClient.setQueryData<Settings>(queryKeys.settings.general(), (old) =>
    old ? { ...old, ...patch } : old,
  );
  void queryClient.invalidateQueries({ queryKey: queryKeys.settings.general() });
}

type SwitchSetting = {
  [K in keyof SettingsPatch]-?: NonNullable<SettingsPatch[K]> extends boolean ? K : never;
}[keyof SettingsPatch];

/**
 * A one-switch card that saves as it is flipped, the way a system setting does: no draft and no
 * Save footer, so nothing is ever unsaved. The switch takes the new position at once; a failed
 * save puts it back, and the error toast says why. A flip while a save is in flight is ignored,
 * so two patches never race, and focus stays on the switch throughout.
 */
export function useInstantSetting(
  key: SwitchSetting,
  saved: boolean,
): { checked: boolean; onCheckedChange: (checked: boolean) => void } {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<boolean | null>(null);
  const { save, saving } = useSectionSave((patch: SettingsPatch) => updateSettings(patch), {
    onSaved: (patch) => {
      writeSettingsCache(queryClient, patch);
      setPending(null);
    },
    onFailed: () => setPending(null),
  });
  return {
    checked: pending ?? saved,
    onCheckedChange: (checked) => {
      if (saving) return;
      setPending(checked);
      save({ [key]: checked });
    },
  };
}
