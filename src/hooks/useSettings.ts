/**
 * useSettings — extracted from App.tsx (T1).
 *
 * Owns ALL state, refs, mirror effects, toggle / stepper handlers, and the
 * native-prefs load routine for the 11 user-facing settings exposed in the
 * НАСТРОЙКИ section of the UI. App.tsx delegates to this hook so its own line
 * count stays manageable.
 *
 * Behavioural invariants preserved verbatim from the original inline code:
 *
 *   - All toggles (except showMovingTime) are LOCKED while a recording is in
 *     progress (`settingsLocked` param). The lock is checked at handler entry
 *     and the handler returns early if true.
 *   - showMovingTime is intentionally unlocked during recording (Task 4 spec)
 *     — the user can flip it any time, including mid-recording.
 *   - U15 re-entrancy guard: every handler checks `settingsUpdatingRef.current`
 *     at entry and bails out if a previous toggle / stepper is still in flight.
 *     The guard is shared across ALL handlers so two simultaneous taps on
 *     different rows also serialize.
 *   - Optimistic UI update + revert-on-error pattern: each handler sets the
 *     new value locally first, awaits the native setter, applies the confirmed
 *     value, and on catch reverts to the previous value + surfaces the error
 *     via `setErrorMsg`.
 *   - The three numeric stepper handlers clamp to the same ranges as the
 *     native side (see GpsRecorderModule.kt):
 *       radialDistanceThresholdM   → [0, 1000]
 *       timeSamplingN              → [1, 60]
 *       douglasPeuckerEpsilonM     → [0, 500]
 *   - The `autoPauseEnabledRef`, `gapDetectionEnabledRef`, and
 *     `showMovingTimeRef` refs are kept in sync with their state counterparts
 *     via mirror useEffects and are RETURNED by the hook so the 'saved'
 *     event handler (set up once at mount inside App.tsx) can read their
 *     latest values at save time without stale-closure issues.
 *   - `settingsUpdatingRef` is INTERNAL to this hook and NOT returned — no
 *     external code needs to read or mutate it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { GpsRecorder } from '../NativeGpsRecorder';

export type UseSettingsReturn = {
  // ---- 11 settings state vars ----
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

  // ---- 3 mirror refs (read by App.tsx 'saved' handler at save time) ----
  autoPauseEnabledRef: React.MutableRefObject<boolean>;
  gapDetectionEnabledRef: React.MutableRefObject<boolean>;
  showMovingTimeRef: React.MutableRefObject<boolean>;

  // ---- 10 toggle / stepper handlers ----
  handleTogglePostProcess: () => Promise<void>;
  handleToggleGaussianSmoothing: () => Promise<void>;
  handleToggleAutoPause: () => Promise<void>;
  handleToggleGapDetection: () => Promise<void>;
  handleToggleShowMovingTime: () => Promise<void>;
  handleToggleRadialDistanceFilter: () => Promise<void>;
  handleStepperRadialThreshold: (delta: number) => Promise<void>;
  handleToggleTimeSampling: () => Promise<void>;
  handleStepperTimeSamplingN: (delta: number) => Promise<void>;
  handleToggleDouglasPeucker: () => Promise<void>;
  handleStepperDouglasPeuckerEpsilon: (delta: number) => Promise<void>;

  // ---- one-shot loader called from App.tsx mount effect ----
  loadSettings: () => Promise<void>;
};

/**
 * @param settingsLocked  true while a recording is in progress — all toggles
 *                        (except showMovingTime) return early when locked.
 * @param setErrorMsg     error-surfacing callback from App.tsx — invoked with
 *                        the caught error message when a native setter rejects.
 */
export function useSettings(
  settingsLocked: boolean,
  setErrorMsg: (msg: string | null) => void,
): UseSettingsReturn {
  // ---- 11 settings state vars ----
  const [postProcessEnabled, setPostProcessEnabled] = useState<boolean>(false);
  const [gaussianSmoothingEnabled, setGaussianSmoothingEnabled] = useState<boolean>(false);
  // Phase 1/3/4: auto-pause setting + live pause / signal state + moving time.
  const [autoPauseEnabled, setAutoPauseEnabled] = useState<boolean>(false);
  // Phase 4 toggle: gap detection (signal-loss segment splits). Defaults to
  // true so existing users keep the behaviour from the previous APK.
  const [gapDetectionEnabled, setGapDetectionEnabled] = useState<boolean>(true);
  // CODE_REVIEW_TODO Task 4: display-only toggle. When ON, the top time
  // display shows movingMs (active moving time, excludes auto-paused and
  // signal-lost intervals) and avg pace uses movingMs. When OFF, the UI
  // shows elapsedMs (wall-clock) — the legacy behaviour. NOT locked while
  // recording: the user can toggle it any time, including mid-recording.
  const [showMovingTime, setShowMovingTime] = useState<boolean>(false);
  // Three independent data-reduction filters (user requested). Each has an
  // enabled toggle plus a numeric parameter, exposed via the new
  // setRadialDistanceFilter* / setTimeSampling* / setDouglasPeucker* bridge
  // methods. All are persisted in the separate settings prefs file so they
  // survive the per-recording state clear, and all are locked while a
  // recording is in progress (see settingsLocked).
  const [radialDistanceFilterEnabled, setRadialDistanceFilterEnabled] = useState<boolean>(false);
  const [radialDistanceThresholdM, setRadialDistanceThresholdM] = useState<number>(5);
  const [timeSamplingEnabled, setTimeSamplingEnabled] = useState<boolean>(false);
  const [timeSamplingN, setTimeSamplingN] = useState<number>(5);
  const [douglasPeuckerEnabled, setDouglasPeuckerEnabled] = useState<boolean>(false);
  const [douglasPeuckerEpsilonM, setDouglasPeuckerEpsilonM] = useState<number>(5);

  // ---- 4 refs (1 internal + 3 mirror, returned) ----
  // U15: re-entrancy guard for settings toggles. Without this, a second tap
  // before the first await resolves would cause the first setX(confirmed)
  // to overwrite the second optimistic update. Each toggle handler checks
  // this ref at entry and bails out if a previous toggle is still in flight.
  // INTERNAL — not returned.
  const settingsUpdatingRef = useRef<boolean>(false);
  // Refs that mirror autoPauseEnabled / gapDetectionEnabled / showMovingTime
  // so the 'saved' event handler (set up ONCE in App.tsx's mount effect and
  // must NOT re-run on every state change, otherwise we lose events) can
  // read their latest values at save time. RETURNED — App.tsx reads them.
  const autoPauseEnabledRef = useRef<boolean>(false);
  // Bugfix: mirror gapDetectionEnabled too, so the saved-card pace logic
  // can read it from the (once-set-up) saved-event closure. See the
  // paceTimeMs comment in App.tsx for why gap detection now also affects pace.
  const gapDetectionEnabledRef = useRef<boolean>(true);
  // CODE_REVIEW_TODO Task 4: mirror of showMovingTime for use inside the
  // 'saved' event handler (set up once at mount) so it can read the latest
  // value at save time without stale-closure issues. Affects which time
  // base (movingMs vs elapsedMs) is used for the saved-card pace display.
  const showMovingTimeRef = useRef<boolean>(false);

  // ---- 3 mirror effects (state → ref sync) ----
  useEffect(() => { autoPauseEnabledRef.current = autoPauseEnabled; }, [autoPauseEnabled]);
  useEffect(() => { gapDetectionEnabledRef.current = gapDetectionEnabled; }, [gapDetectionEnabled]);
  // Task 4: keep showMovingTimeRef in sync so the 'saved' handler (set up
  // once at mount) can read the latest value at save time.
  useEffect(() => { showMovingTimeRef.current = showMovingTime; }, [showMovingTime]);

  // ---- 10 toggle / stepper handlers ----
  // Each follows the same optimistic-update + revert-on-error + U15
  // re-entrancy-guard pattern. The steppers additionally clamp to the native
  // side's range and skip the round-trip if the clamped value equals the
  // current value (nothing to do).

  const handleTogglePostProcess = useCallback(async () => {
    if (settingsLocked) return; // locked during recording
    // U15: re-entrancy guard — a second tap before the first await resolves
    // would race with the optimistic update.
    if (settingsUpdatingRef.current) return;
    settingsUpdatingRef.current = true;
    const next = !postProcessEnabled;
    setPostProcessEnabled(next); // optimistic UI update
    try {
      const confirmed = await GpsRecorder.setPostProcessEnabled(next);
      setPostProcessEnabled(confirmed);
    } catch (e: unknown) {
      // revert on failure
      setPostProcessEnabled(!next);
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      settingsUpdatingRef.current = false;
    }
  }, [postProcessEnabled, settingsLocked, setErrorMsg]);

  const handleToggleGaussianSmoothing = useCallback(async () => {
    if (settingsLocked) return; // locked during recording
    if (settingsUpdatingRef.current) return; // U15
    settingsUpdatingRef.current = true;
    const next = !gaussianSmoothingEnabled;
    setGaussianSmoothingEnabled(next); // optimistic UI update
    try {
      const confirmed = await GpsRecorder.setGaussianSmoothingEnabled(next);
      setGaussianSmoothingEnabled(confirmed);
    } catch (e: unknown) {
      // revert on failure
      setGaussianSmoothingEnabled(!next);
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      settingsUpdatingRef.current = false;
    }
  }, [gaussianSmoothingEnabled, settingsLocked, setErrorMsg]);

  // Phase 1: toggle the auto-pause setting. Persisted in the separate
  // settings prefs file so it survives the per-recording state clear. Like
  // the other two settings, it is locked during an active recording so
  // toggling it mid-recording can't change the stop-detection behaviour
  // halfway through the file.
  const handleToggleAutoPause = useCallback(async () => {
    if (settingsLocked) return;
    if (settingsUpdatingRef.current) return; // U15
    settingsUpdatingRef.current = true;
    const next = !autoPauseEnabled;
    setAutoPauseEnabled(next);
    try {
      const confirmed = await GpsRecorder.setAutoPauseEnabled(next);
      setAutoPauseEnabled(confirmed);
    } catch (e: unknown) {
      setAutoPauseEnabled(!next);
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      settingsUpdatingRef.current = false;
    }
  }, [autoPauseEnabled, settingsLocked, setErrorMsg]);

  // Phase 4: toggle the gap-detection setting. Same persistence + lock-
  // during-recording semantics as the other toggles. Default is on; turning
  // it off restores the legacy pre-Phase-4 behaviour where signal outages
  // do NOT split the track and the signal-lost UI banner never appears.
  const handleToggleGapDetection = useCallback(async () => {
    if (settingsLocked) return;
    if (settingsUpdatingRef.current) return; // U15
    settingsUpdatingRef.current = true;
    const next = !gapDetectionEnabled;
    setGapDetectionEnabled(next);
    try {
      const confirmed = await GpsRecorder.setGapDetectionEnabled(next);
      setGapDetectionEnabled(confirmed);
    } catch (e: unknown) {
      setGapDetectionEnabled(!next);
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      settingsUpdatingRef.current = false;
    }
  }, [gapDetectionEnabled, settingsLocked, setErrorMsg]);

  // CODE_REVIEW_TODO Task 4: toggle the show-moving-time display preference.
  // Pure display setting — NOT locked while recording (the user can toggle
  // it any time, including mid-recording). The native side always emits
  // both elapsedMs and movingMs in every duration / location / state event,
  // so flipping this setting only changes which value the UI displays on
  // the next event (1 Hz duration tick). Persisted in the same prefs file
  // as the other toggles so it survives app restarts and the per-recording
  // state clear.
  const handleToggleShowMovingTime = useCallback(async () => {
    // NOTE: no settingsLocked check — this toggle is intentionally unlocked
    // during recording per Task 4 spec.
    if (settingsUpdatingRef.current) return; // U15 shared re-entrancy guard
    settingsUpdatingRef.current = true;
    const prev = showMovingTimeRef.current;
    const next = !prev;
    setShowMovingTime(next); // optimistic UI update
    showMovingTimeRef.current = next;
    try {
      const confirmed = await GpsRecorder.setShowMovingTimeEnabled(next);
      setShowMovingTime(confirmed);
      showMovingTimeRef.current = confirmed;
    } catch (e: unknown) {
      // revert on error
      setShowMovingTime(prev);
      showMovingTimeRef.current = prev;
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      settingsUpdatingRef.current = false;
    }
  }, [setErrorMsg]);

  // ---- Three data-reduction filter toggles + steppers ----
  //
  // Each filter has an enabled toggle (persisted boolean) + a numeric
  // parameter (persisted int / double). The steppers clamp to the same
  // ranges as the native side (see GpsRecorderModule.kt) so the UI never
  // shows a value the native side will reject. All are locked while a
  // recording is in progress.

  const handleToggleRadialDistanceFilter = useCallback(async () => {
    if (settingsLocked) return;
    if (settingsUpdatingRef.current) return; // U15
    settingsUpdatingRef.current = true;
    const next = !radialDistanceFilterEnabled;
    setRadialDistanceFilterEnabled(next);
    try {
      const confirmed = await GpsRecorder.setRadialDistanceFilterEnabled(next);
      setRadialDistanceFilterEnabled(confirmed);
    } catch (e: unknown) {
      setRadialDistanceFilterEnabled(!next);
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      settingsUpdatingRef.current = false;
    }
  }, [radialDistanceFilterEnabled, settingsLocked, setErrorMsg]);

  const handleStepperRadialThreshold = useCallback(async (delta: number) => {
    if (settingsLocked) return;
    if (settingsUpdatingRef.current) return; // U15
    settingsUpdatingRef.current = true;
    const next = Math.max(0, Math.min(1000, radialDistanceThresholdM + delta));
    if (next === radialDistanceThresholdM) {
      settingsUpdatingRef.current = false;
      return;
    }
    setRadialDistanceThresholdM(next); // optimistic
    try {
      const confirmed = await GpsRecorder.setRadialDistanceThresholdM(next);
      setRadialDistanceThresholdM(confirmed);
    } catch (e: unknown) {
      setRadialDistanceThresholdM(radialDistanceThresholdM); // revert
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      settingsUpdatingRef.current = false;
    }
  }, [radialDistanceThresholdM, settingsLocked, setErrorMsg]);

  const handleToggleTimeSampling = useCallback(async () => {
    if (settingsLocked) return;
    if (settingsUpdatingRef.current) return; // U15
    settingsUpdatingRef.current = true;
    const next = !timeSamplingEnabled;
    setTimeSamplingEnabled(next);
    try {
      const confirmed = await GpsRecorder.setTimeSamplingEnabled(next);
      setTimeSamplingEnabled(confirmed);
    } catch (e: unknown) {
      setTimeSamplingEnabled(!next);
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      settingsUpdatingRef.current = false;
    }
  }, [timeSamplingEnabled, settingsLocked, setErrorMsg]);

  const handleStepperTimeSamplingN = useCallback(async (delta: number) => {
    if (settingsLocked) return;
    if (settingsUpdatingRef.current) return; // U15
    settingsUpdatingRef.current = true;
    const next = Math.max(1, Math.min(60, timeSamplingN + delta));
    if (next === timeSamplingN) {
      settingsUpdatingRef.current = false;
      return;
    }
    setTimeSamplingN(next);
    try {
      const confirmed = await GpsRecorder.setTimeSamplingN(next);
      setTimeSamplingN(confirmed);
    } catch (e: unknown) {
      setTimeSamplingN(timeSamplingN);
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      settingsUpdatingRef.current = false;
    }
  }, [timeSamplingN, settingsLocked, setErrorMsg]);

  const handleToggleDouglasPeucker = useCallback(async () => {
    if (settingsLocked) return;
    if (settingsUpdatingRef.current) return; // U15
    settingsUpdatingRef.current = true;
    const next = !douglasPeuckerEnabled;
    setDouglasPeuckerEnabled(next);
    try {
      const confirmed = await GpsRecorder.setDouglasPeuckerEnabled(next);
      setDouglasPeuckerEnabled(confirmed);
    } catch (e: unknown) {
      setDouglasPeuckerEnabled(!next);
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      settingsUpdatingRef.current = false;
    }
  }, [douglasPeuckerEnabled, settingsLocked, setErrorMsg]);

  const handleStepperDouglasPeuckerEpsilon = useCallback(async (delta: number) => {
    if (settingsLocked) return;
    if (settingsUpdatingRef.current) return; // U15
    settingsUpdatingRef.current = true;
    const next = Math.max(0, Math.min(500, douglasPeuckerEpsilonM + delta));
    if (next === douglasPeuckerEpsilonM) {
      settingsUpdatingRef.current = false;
      return;
    }
    setDouglasPeuckerEpsilonM(next);
    try {
      const confirmed = await GpsRecorder.setDouglasPeuckerEpsilonM(next);
      setDouglasPeuckerEpsilonM(confirmed);
    } catch (e: unknown) {
      setDouglasPeuckerEpsilonM(douglasPeuckerEpsilonM);
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      settingsUpdatingRef.current = false;
    }
  }, [douglasPeuckerEpsilonM, settingsLocked, setErrorMsg]);

  // ---- one-shot loader: replaces the inline settings-load block that used
  // to live inside App.tsx's mount effect. Loads all 11 settings from native
  // prefs (each call independently try/caught so a failure on one doesn't
  // skip the rest) and applies them to local state.
  //
  // App.tsx calls `await loadSettings()` from inside its mount effect's
  // async IIFE; the surrounding `mounted` flag there guards against
  // setState-after-unmount across the awaits.
  const loadSettings = useCallback(async () => {
    // Load the post-process setting from native prefs.
    try {
      const pp = await GpsRecorder.getPostProcessEnabled();
      setPostProcessEnabled(pp);
    } catch { /* ignore */ }

    // Load the Gaussian-smoothing setting from native prefs.
    try {
      const gs = await GpsRecorder.getGaussianSmoothingEnabled();
      setGaussianSmoothingEnabled(gs);
    } catch { /* ignore */ }

    // Phase 1: load the auto-pause setting from native prefs.
    try {
      const ap = await GpsRecorder.getAutoPauseEnabled();
      setAutoPauseEnabled(ap);
    } catch { /* ignore */ }

    // Phase 4: load the gap-detection setting from native prefs.
    // Default is true (the previous APK always ran gap detection), so if
    // the native side returns false here it's a real user choice.
    try {
      const gd = await GpsRecorder.getGapDetectionEnabled();
      setGapDetectionEnabled(gd);
    } catch { /* ignore */ }

    // CODE_REVIEW_TODO Task 4: load the show-moving-time display
    // preference. Default is false (legacy wall-clock display).
    try {
      const smt = await GpsRecorder.getShowMovingTimeEnabled();
      setShowMovingTime(smt);
    } catch { /* ignore */ }

    // Load the three data-reduction filter settings from native prefs.
    // Each has a boolean enabled flag + a numeric parameter.
    try {
      const rde = await GpsRecorder.getRadialDistanceFilterEnabled();
      setRadialDistanceFilterEnabled(rde);
      const rdt = await GpsRecorder.getRadialDistanceThresholdM();
      setRadialDistanceThresholdM(rdt);
    } catch { /* ignore */ }
    try {
      const tse = await GpsRecorder.getTimeSamplingEnabled();
      setTimeSamplingEnabled(tse);
      const tsn = await GpsRecorder.getTimeSamplingN();
      setTimeSamplingN(tsn);
    } catch { /* ignore */ }
    try {
      const dpe = await GpsRecorder.getDouglasPeuckerEnabled();
      setDouglasPeuckerEnabled(dpe);
      const dpeps = await GpsRecorder.getDouglasPeuckerEpsilonM();
      setDouglasPeuckerEpsilonM(dpeps);
    } catch { /* ignore */ }
  }, []);

  return {
    // state
    postProcessEnabled,
    gaussianSmoothingEnabled,
    autoPauseEnabled,
    gapDetectionEnabled,
    showMovingTime,
    radialDistanceFilterEnabled,
    radialDistanceThresholdM,
    timeSamplingEnabled,
    timeSamplingN,
    douglasPeuckerEnabled,
    douglasPeuckerEpsilonM,

    // mirror refs (read by App.tsx 'saved' handler at save time)
    autoPauseEnabledRef,
    gapDetectionEnabledRef,
    showMovingTimeRef,

    // handlers
    handleTogglePostProcess,
    handleToggleGaussianSmoothing,
    handleToggleAutoPause,
    handleToggleGapDetection,
    handleToggleShowMovingTime,
    handleToggleRadialDistanceFilter,
    handleStepperRadialThreshold,
    handleToggleTimeSampling,
    handleStepperTimeSamplingN,
    handleToggleDouglasPeucker,
    handleStepperDouglasPeuckerEpsilon,

    // loader
    loadSettings,
  };
}
