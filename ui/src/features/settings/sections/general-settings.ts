import { useQueryClient } from "@tanstack/react-query";
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
      queryClient.setQueryData<Settings>(queryKeys.settings.general(), (old) =>
        old ? { ...old, ...patch } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.general() });
    },
  });
}
