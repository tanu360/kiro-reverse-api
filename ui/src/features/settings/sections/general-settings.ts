import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { queryKeys } from "@/lib/api/query-keys";
import { updateSettings } from "@/lib/api/settings";
import type { Settings, SettingsPatch } from "@/lib/api/types";
import type { Draft } from "../lib/dirty";
import { type SaveFeedback, useSectionSave } from "./settings-section";

/**
 * Saves one card's slice of GET /settings. POST /settings is a non-atomic patch, so the card
 * sends only its own fields. On success the slice is written into the cached settings before
 * the refetch, so the other cards and this one agree at once.
 */
export function useGeneralSettingsSave<D>(draft: Draft<D>): {
  save: (patch: D & SettingsPatch) => void;
  saving: boolean;
  feedback: SaveFeedback;
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
function writeSettingsCache(
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

/** A failed instant save, for RowActionError: Try again sends the same pick again. */
export interface InstantFailure {
  error: unknown;
  retry: () => void;
  dismiss: () => void;
}

/**
 * A setting that saves as it is set (a switch, a select, a segmented choice), the way a system
 * setting does: no draft and no Save footer, so nothing is ever unsaved. The control takes the
 * new value at once and a screen reader hears it saved; a failed save puts the saved value back
 * and `failure` says why under the row. A change while a save is in flight is ignored, so two
 * patches never race, and focus stays on the control throughout.
 */
export function useInstantValue<T extends boolean | number | string>(
  saved: T,
  toPatch: (value: T) => SettingsPatch,
): { value: T; onChange: (value: T) => void; failure: InstantFailure | null } {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<T | null>(null);
  const [attempt, setAttempt] = useState<T | null>(null);
  const { save, saving, feedback } = useSectionSave(
    (patch: SettingsPatch) => updateSettings(patch),
    {
      onSaved: (patch) => {
        writeSettingsCache(queryClient, patch);
        setPending(null);
      },
      onFailed: () => setPending(null),
    },
  );
  const value = pending ?? saved;
  // A new saved value from the server (another tab, a refetch) makes a failed pick moot: its
  // notice goes, so Try again never resends a stale pick or does nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the saved value changes.
  useEffect(() => {
    if (feedback.error != null) feedback.dismiss();
  }, [saved]);
  const onChange = (next: T) => {
    if (saving || next === value) return;
    setPending(next);
    setAttempt(next);
    save(toPatch(next));
  };
  return {
    value,
    onChange,
    failure:
      feedback.error != null && attempt !== null
        ? { error: feedback.error, retry: () => onChange(attempt), dismiss: feedback.dismiss }
        : null,
  };
}

/** A one-switch setting that saves as it is flipped (useInstantValue). */
export function useInstantSetting(
  key: SwitchSetting,
  saved: boolean,
): {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  failure: InstantFailure | null;
} {
  const setting = useInstantValue(saved, (checked) => ({ [key]: checked }));
  return {
    checked: setting.value,
    onCheckedChange: setting.onChange,
    failure: setting.failure,
  };
}
