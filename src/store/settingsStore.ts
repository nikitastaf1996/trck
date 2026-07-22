/**
 * settingsStore — the single source of truth for the 11 user-facing settings.
 *
 * Previously this was `useSettings.ts` (482 lines): 11 near-identical
 * `useCallback` handlers, each with the same optimistic-update + revert-
 * on-error + U15 re-entrancy-guard boilerplate, plus 11 useState hooks
 * and 3 mirror refs. That has been collapsed into:
 *
 *   - A single SETTINGS_SPEC table describing all 11 settings: their
 *     key, type, default, native getter/setter, clamp range, and whether
 *     they're locked while recording.
 *   - One generic `setSetting(key, value)` action that handles the
 *     optimistic-update + revert-on-error + re-entrancy-guard pattern
 *     once, for all settings.
 *   - One `loadAllSettings()` action called from App.tsx's mount effect.
 *
 * Components / App.tsx read settings via `useSettingsStore(s => s.foo)`
 * (zustand selector) or `useSetting('foo')` (typed helper).
 *
 * The 11 settings mirror GpsRecorderSettings.kt on the native side. The
 * native prefs file is "gps_recorder_settings" (separate from the per-
 * recording "gps_recorder_state" file, so settings survive the per-
 * recording clear in stopRecording()).
 */

import { create } from 'zustand';
import { GpsRecorder } from '../NativeGpsRecorder';
import { useRecordingStore } from './recordingStore';

// ---------------------------------------------------------------------------
// Settings spec — the single source of truth for the 11 settings.
// ---------------------------------------------------------------------------

/**
 * A toggle (boolean) setting, e.g. `postProcessEnabled`.
 *  - `locked`: cannot be changed while a recording is in progress.
 *  - `nativeGet` / `nativeSet`: the bridge methods.
 */
type ToggleSpec = {
  type: 'boolean';
  default: boolean;
  locked: boolean;
  nativeGet: () => Promise<boolean>;
  nativeSet: (v: boolean) => Promise<boolean>;
};

/**
 * A numeric setting with a clamp range, e.g. `radialDistanceThresholdM`.
 *  - `min` / `max`: clamp range, matches the native side.
 *  - `locked`: cannot be changed while a recording is in progress.
 */
type NumberSpec = {
  type: 'number';
  default: number;
  min: number;
  max: number;
  step: number;
  locked: boolean;
  nativeGet: () => Promise<number>;
  nativeSet: (v: number) => Promise<number>;
};

export const SETTINGS_SPEC = {
  postProcessEnabled: {
    type: 'boolean',
    default: false,
    locked: true,
    nativeGet: () => GpsRecorder.getPostProcessEnabled(),
    nativeSet: (v: boolean) => GpsRecorder.setPostProcessEnabled(v),
  },
  gaussianSmoothingEnabled: {
    type: 'boolean',
    default: false,
    locked: true,
    nativeGet: () => GpsRecorder.getGaussianSmoothingEnabled(),
    nativeSet: (v: boolean) => GpsRecorder.setGaussianSmoothingEnabled(v),
  },
  autoPauseEnabled: {
    type: 'boolean',
    default: false,
    locked: true,
    nativeGet: () => GpsRecorder.getAutoPauseEnabled(),
    nativeSet: (v: boolean) => GpsRecorder.setAutoPauseEnabled(v),
  },
  // Phase 4: gap detection defaults to TRUE so existing users keep the
  // behaviour from the previous APK (signal outages split the track).
  gapDetectionEnabled: {
    type: 'boolean',
    default: true,
    locked: true,
    nativeGet: () => GpsRecorder.getGapDetectionEnabled(),
    nativeSet: (v: boolean) => GpsRecorder.setGapDetectionEnabled(v),
  },
  // Task 4: pure display setting — NOT locked while recording. The user
  // can flip it any time, including mid-recording, to switch the top
  // time display between wall-clock (elapsedMs) and moving time.
  showMovingTime: {
    type: 'boolean',
    default: false,
    locked: false,
    nativeGet: () => GpsRecorder.getShowMovingTimeEnabled(),
    nativeSet: (v: boolean) => GpsRecorder.setShowMovingTimeEnabled(v),
  },
  radialDistanceFilterEnabled: {
    type: 'boolean',
    default: false,
    locked: true,
    nativeGet: () => GpsRecorder.getRadialDistanceFilterEnabled(),
    nativeSet: (v: boolean) => GpsRecorder.setRadialDistanceFilterEnabled(v),
  },
  radialDistanceThresholdM: {
    type: 'number',
    default: 5,
    min: 0,
    max: 1000,
    step: 1,
    locked: true,
    nativeGet: () => GpsRecorder.getRadialDistanceThresholdM(),
    nativeSet: (v: number) => GpsRecorder.setRadialDistanceThresholdM(v),
  },
  timeSamplingEnabled: {
    type: 'boolean',
    default: false,
    locked: true,
    nativeGet: () => GpsRecorder.getTimeSamplingEnabled(),
    nativeSet: (v: boolean) => GpsRecorder.setTimeSamplingEnabled(v),
  },
  timeSamplingN: {
    type: 'number',
    default: 5,
    min: 1,
    max: 60,
    step: 1,
    locked: true,
    nativeGet: () => GpsRecorder.getTimeSamplingN(),
    nativeSet: (v: number) => GpsRecorder.setTimeSamplingN(v),
  },
  douglasPeuckerEnabled: {
    type: 'boolean',
    default: false,
    locked: true,
    nativeGet: () => GpsRecorder.getDouglasPeuckerEnabled(),
    nativeSet: (v: boolean) => GpsRecorder.setDouglasPeuckerEnabled(v),
  },
  douglasPeuckerEpsilonM: {
    type: 'number',
    default: 5,
    min: 0,
    max: 500,
    step: 1,
    locked: true,
    nativeGet: () => GpsRecorder.getDouglasPeuckerEpsilonM(),
    nativeSet: (v: number) => GpsRecorder.setDouglasPeuckerEpsilonM(v),
  },
} as const;

export type SettingKey = keyof typeof SETTINGS_SPEC;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type SettingsStoreState = {
  // The 11 setting values. Initialised from SETTINGS_SPEC defaults; the
  // real values are loaded from native prefs on mount via loadAllSettings().
  postProcessEnabled: boolean;
  gaussianSmoothingEnabled: boolean;
  autoPauseEnabled: boolean;
  gapDetectionEnabled: boolean;
  showMovingTime: boolean;
  radialDistanceFilterEnabled: boolean;
  radialDistanceThresholdM: number;
  timeSamplingEnabled: boolean;
  timeSamplingN: number;
  douglasPeuckerEnabled: boolean;
  douglasPeuckerEpsilonM: number;

  // Internal: re-entrancy guard. A second toggle while the first is
  // still awaiting its native round-trip would race with the optimistic
  // update. Shared across all settings so two simultaneous taps on
  // different rows also serialize.
  _updating: boolean;

  // ---- Actions ----

  /**
   * Toggle a boolean setting. Optimistic update + revert-on-error +
   * re-entrancy guard + lock check (skips if locked while recording).
   */
  toggle: (key: SettingKey) => Promise<void>;

  /**
   * Step a numeric setting by `delta` (e.g. +1 / -1). Clamps to the
   * spec's [min, max] range. Skips if the clamped value equals the
   * current value.
   */
  step: (key: SettingKey, delta: number) => Promise<void>;

  /** Load all 11 settings from native prefs. Called once on mount. */
  loadAll: () => Promise<void>;
};

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  // Initialise from spec defaults. The real values are loaded on mount.
  postProcessEnabled: SETTINGS_SPEC.postProcessEnabled.default,
  gaussianSmoothingEnabled: SETTINGS_SPEC.gaussianSmoothingEnabled.default,
  autoPauseEnabled: SETTINGS_SPEC.autoPauseEnabled.default,
  gapDetectionEnabled: SETTINGS_SPEC.gapDetectionEnabled.default,
  showMovingTime: SETTINGS_SPEC.showMovingTime.default,
  radialDistanceFilterEnabled: SETTINGS_SPEC.radialDistanceFilterEnabled.default,
  radialDistanceThresholdM: SETTINGS_SPEC.radialDistanceThresholdM.default,
  timeSamplingEnabled: SETTINGS_SPEC.timeSamplingEnabled.default,
  timeSamplingN: SETTINGS_SPEC.timeSamplingN.default,
  douglasPeuckerEnabled: SETTINGS_SPEC.douglasPeuckerEnabled.default,
  douglasPeuckerEpsilonM: SETTINGS_SPEC.douglasPeuckerEpsilonM.default,
  _updating: false,

  toggle: async (key) => {
    const spec = SETTINGS_SPEC[key];
    if (spec.type !== 'boolean') return;
    // Lock check: skip if locked AND a recording is in progress.
    if (spec.locked) {
      const recordingState = useRecordingStore.getState().recordingState;
      if (recordingState === 'recording' || recordingState === 'stopping') return;
    }
    // Re-entrancy guard.
    if (get()._updating) return;
    set({ _updating: true });

    const current = get()[key] as boolean;
    const next = !current;
    set({ [key]: next } as Partial<SettingsStoreState>); // optimistic
    try {
      const confirmed = await spec.nativeSet(next);
      set({ [key]: confirmed } as Partial<SettingsStoreState>);
    } catch (e: unknown) {
      // Revert on error.
      set({ [key]: current } as Partial<SettingsStoreState>);
      useRecordingStore.getState().setError(e instanceof Error ? e.message : String(e));
    } finally {
      set({ _updating: false });
    }
  },

  step: async (key, delta) => {
    const spec = SETTINGS_SPEC[key];
    if (spec.type !== 'number') return;
    if (spec.locked) {
      const recordingState = useRecordingStore.getState().recordingState;
      if (recordingState === 'recording' || recordingState === 'stopping') return;
    }
    if (get()._updating) return;
    set({ _updating: true });

    const current = get()[key] as number;
    const next = Math.max(spec.min, Math.min(spec.max, current + delta));
    if (next === current) {
      set({ _updating: false });
      return;
    }
    set({ [key]: next } as Partial<SettingsStoreState>); // optimistic
    try {
      const confirmed = await spec.nativeSet(next);
      set({ [key]: confirmed } as Partial<SettingsStoreState>);
    } catch (e: unknown) {
      set({ [key]: current } as Partial<SettingsStoreState>); // revert
      useRecordingStore.getState().setError(e instanceof Error ? e.message : String(e));
    } finally {
      set({ _updating: false });
    }
  },

  loadAll: async () => {
    // Each load is independently try/caught so a failure on one
    // doesn't skip the rest. Errors are silent — the spec defaults
    // remain in place, which is the safest fallback.
    const entries = Object.entries(SETTINGS_SPEC) as [SettingKey, ToggleSpec | NumberSpec][];
    const updates: Partial<SettingsStoreState> = {};
    await Promise.all(entries.map(async ([key, spec]) => {
      try {
        const value = await spec.nativeGet();
        (updates as Record<string, unknown>)[key] = value;
      } catch {
        // ignore — keep the spec default
      }
    }));
    if (Object.keys(updates).length > 0) {
      set(updates);
    }
  },
}));

// ---------------------------------------------------------------------------
// Convenience hook: typed access to a single setting + its toggle/step fn.
// ---------------------------------------------------------------------------

/**
 * Use a single boolean setting. Returns `[value, toggle]`.
 *
 *   const [autoPause, toggleAutoPause] = useToggleSetting('autoPauseEnabled');
 *
 * Re-renders only when this specific setting changes (zustand selector).
 */
export function useToggleSetting(key: SettingKey): [boolean, () => Promise<void>] {
  const value = useSettingsStore((s) => s[key] as boolean);
  const toggle = useSettingsStore((s) => s.toggle);
  return [value, () => toggle(key)];
}

/**
 * Use a single numeric setting. Returns `[value, step]`.
 *
 *   const [threshold, stepThreshold] = useNumberSetting('radialDistanceThresholdM');
 *   stepThreshold(+1); // increment
 *   stepThreshold(-1); // decrement
 */
export function useNumberSetting(
  key: SettingKey,
): [number, (delta: number) => Promise<void>] {
  const value = useSettingsStore((s) => s[key] as number);
  const step = useSettingsStore((s) => s.step);
  return [value, (delta: number) => step(key, delta)];
}

/**
 * Returns true if settings are currently locked (a recording is in
 * progress or stopping). Convenience for App.tsx's settingsLocked badge.
 */
export function useSettingsLocked(): boolean {
  const recordingState = useRecordingStore((s) => s.recordingState);
  return recordingState === 'recording' || recordingState === 'stopping';
}
