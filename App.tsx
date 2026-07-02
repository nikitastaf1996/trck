/**
 * trck — a no-frills GPS recorder for runners.
 *
 * UI inspired by minimalist running watches / running apps: large, centered
 * numbers, generous whitespace, one accent color, no clutter.
 *
 *   - Big circular START / STOP button at the bottom
 *   - Pre-recording GNSS status pill (always visible, updates live)
 *   - TIME · DISTANCE · PACE · AVG PACE
 *   - Saved-file toast when a recording finishes
 *
 * Stability / lifecycle behaviour (unchanged from previous versions):
 *   - Recording is owned by a native foreground service (GpsRecorderService.kt).
 *   - The service survives: app being backgrounded, app being swiped away from
 *     recents, the screen turning off, and (best-effort) the system killing the
 *     process for memory. It is START_STICKY and uses a PARTIAL_WAKE_LOCK.
 *   - Points are flushed to a temp file every 5 seconds so a crash mid-recording
 *     still yields a usable (partial) GPX file.
 *   - The notification has a "Stop" action so the user can stop recording
 *     without re-opening the app.
 *   - The JS side is purely informational; if the JS thread dies, recording
 *     continues.
 *
 * Live GNSS monitor:
 *   - On mount, we call GpsRecorder.startGnssMonitor() so the native module
 *     starts listening to GPS + GnssStatus and emits 'gnss' events with the
 *     current fix type / accuracy / satellite counts. This works regardless of
 *     whether recording is running, so the user sees their fix status before
 *     pressing START.
 *   - The monitor is stopped on unmount.
 */

import React, { useEffect, useRef, useState, useCallback, useReducer } from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  GpsRecorder,
  subscribe,
  isNativeModuleAvailable,
  type GpsLocationEvent,
  type GpsStateEvent,
  type GpsSavedEvent,
  type GpsFullState,
  type GpsFixType,
  type GpsGnssEvent,
} from './src/NativeGpsRecorder';
// O19: use react-native-safe-area-context instead of the deprecated built-in.
// The built-in SafeAreaView from 'react-native' is unreliable on Android notches.
import { SafeAreaView } from 'react-native-safe-area-context';
// O8: extracted presentational components + shared palette / formatters.
import { GnssPill } from './src/components/GnssPill';
import { ToggleRow } from './src/components/ToggleRow';
import { FilterSettingGroup } from './src/components/FilterSettingGroup';
import { StatsDisplay } from './src/components/StatsDisplay';
import { StartStopButton } from './src/components/StartStopButton';
import { SavedCard } from './src/components/SavedCard';
import { ErrorCard } from './src/components/ErrorCard';
import { PermissionWaitOverlay, StopOverlay } from './src/components/Overlays';
import {
  SignalLostBanner,
  BatteryOptBanner,
  OverFilterWarning,
} from './src/components/Banners';
import {
  COLOR,
  pluralRu,
  type RecordingState,
} from './src/styles';

function App(): React.ReactElement {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  // U8: pointCount state removed — it was only read by the now-dead
  // `pointCount > 0` status branch. The 'state' event resets it to 0 when
  // recording stops, so when we're not recording it's always 0; when we
  // ARE recording, the status row shows 'ЗАПИСЬ' / 'АВТОПАУЗА' / etc.
  // anyway. Keeping the state (and updating it on every location event)
  // was just causing unnecessary re-renders for a value nobody reads.
  const [distance, setDistance] = useState<number>(0);
  const [currentSpeed, setCurrentSpeed] = useState<number | null>(null);
  const [fixType, setFixType] = useState<GpsFixType>('no fix');
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [satellitesUsed, setSatellitesUsed] = useState<number>(0);
  const [satellitesInView, setSatellitesInView] = useState<number>(0);
  const [hasFix, setHasFix] = useState<boolean>(false);
  const [lastSavedPath, setLastSavedPath] = useState<string | null>(null);
  // Final distance (meters) computed from the SAVED GPX file, post-smoothing.
  // Set when the 'saved' event arrives; shown on the "GPX СОХРАНЁН" card so
  // the user sees the true track length (matching what Strava / other
  // importers will compute) rather than the live-accumulated raw distance.
  const [lastSavedDistance, setLastSavedDistance] = useState<number | null>(null);
  // Final moving time + elapsed time captured at save time so we can show
  // the post-save average pace on the saved card. (The live state values
  // get reset to 0 by the 'saved' handler, so we snapshot them here first.)
  const [lastSavedMovingMs, setLastSavedMovingMs] = useState<number>(0);
  const [lastSavedElapsedMs, setLastSavedElapsedMs] = useState<number>(0);
  // U3: snapshot of the auto-pause / gap-detection toggle state at save
  // time. Without this, the saved card's pace recomputes with whatever the
  // CURRENT toggle state is — so if the user ends a recording and then
  // flips auto-pause on (to prepare for the next run), the just-saved
  // card's pace would flip between moving-time and elapsed-time bases.
  // The snapshot is captured in the 'saved' event handler (BEFORE the user
  // can change anything) and cleared on the next handleStart.
  const [lastSavedSettings, setLastSavedSettings] = useState<{
    autoPauseEnabled: boolean;
    gapDetectionEnabled: boolean;
    // CODE_REVIEW_TODO Task 4: snapshot of showMovingTime at save time.
    showMovingTime: boolean;
  } | null>(null);
  const [hasPermissions, setHasPermissions] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
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
  const [isAutoPaused, setIsAutoPaused] = useState<boolean>(false);
  const [signalLost, setSignalLost] = useState<boolean>(false);
  const [movingMs, setMovingMs] = useState<number>(0);
  // U13: startTimeRef removed — it was dead code (assigned but never read).
  // U1: while true, a full-screen spinner overlay with a "Отмена" button is
  // shown over the UI. Set just before awaiting requestPermissions() and
  // cleared as soon as the await resolves (whether granted or denied). The
  // cancel button sets `cancelPermissionWaitRef.current = true` so that when
  // the await resolves we know to bail out instead of proceeding to start.
  const [waitingForPermissions, setWaitingForPermissions] = useState<boolean>(false);
  const cancelPermissionWaitRef = useRef<boolean>(false);
  // U12: track whether we've already asked the user about battery-optim
  // exemption (so we don't pop the system dialog on every START) and
  // whether they denied it (so we can show a warning banner). The ref
  // survives the component's lifetime; if the app is killed and
  // relaunched, the user will see the dialog once more (acceptable — the
  // alternative would require persisting the flag via native prefs, which
  // is out of scope for the JS-only TODO-3 set).
  const hasAskedBatteryOptRef = useRef<boolean>(false);
  const [batteryOptDenied, setBatteryOptDenied] = useState<boolean>(false);
  // U18: mirror of `recordingState` for use inside event-subscription closures.
  // We keep the main useEffect's deps stable (so the subscriptions are NOT
  // torn down + recreated on every idle -> recording -> stopping -> idle
  // transition, which was causing missed 'state' / 'saved' events). The
  // closures read this ref instead of capturing the state directly.
  // U18: recordingStateRef is updated SYNCHRONOUSLY inside handleStart /
  // handleStop (NOT via useEffect). The previous useEffect-based approach
  // had a race window: between setRecordingState('recording') running and
  // the useEffect firing on the next render, a 'gnss' event could arrive
  // and the handler would read the STALE ref value ('idle') — overriding
  // currentSpeed with the gnss speed even though we just started recording.
  // Synchronous ref updates close that race entirely.
  const recordingStateRef = useRef<RecordingState>('idle');

  // Sliding window of the most recent GPS speeds (m/s) seen during the
  // current recording. Used to compute a smoothed "current pace" instead of
  // relying on the raw instantaneous GPS speed, which jumps around a lot at
  // 1 Hz and makes the TEMPO readout flicker between e.g. 4:30 and 6:10 from
  // one fix to the next. The window is cleared on stop / save so a fresh
  // recording starts with no history.
  //
  // U4: the window is also populated from the 'gnss' event when NOT
  // recording (so the idle pace display uses the same smoothing instead of
  // the raw instantaneous GNSS speed). Pushing to the array doesn't trigger
  // a re-render, so we call forceRerender() after each push to make sure
  // the smoothedSpeed computation below re-runs.
  const recentSpeedsRef = useRef<number[]>([]);
  const SPEED_WINDOW = 5; // ~5 seconds at 1 Hz — short enough to be responsive
  const [, forceRerender] = useReducer(x => x + 1, 0);
  // Refs that mirror movingMs / elapsedMs / autoPauseEnabled so the
  // 'saved' event handler (which is set up ONCE in the mount effect and
  // must NOT re-run on every state change, otherwise we lose events) can
  // read their latest values at save time. Without these the closure would
  // capture the initial 0 values and never see the updated ones.
  const movingMsRef = useRef<number>(0);
  const elapsedMsRef = useRef<number>(0);
  const autoPauseEnabledRef = useRef<boolean>(false);
  // U10: mirror of isAutoPaused for use inside the 'location' event handler
  // (which is set up once at mount and must not re-create on every state
  // change). Without this ref, the handler closure would capture the initial
  // false value and never see auto-pause activate.
  const isAutoPausedRef = useRef<boolean>(false);
  // U16: handleStop schedules a 1 s fallback syncStateFromNative() in case
  // the 'saved' event is delayed or lost. We track the timeout id so the
  // 'saved' event handler can cancel it (avoiding a UI flicker between
  // 'stopping' and 'idle' after the saved card is already shown).
  const stopTimeoutRef = useRef<number | null>(null);
  // Bugfix: mirror gapDetectionEnabled too, so the saved-card pace logic
  // can read it from the (once-set-up) saved-event closure. See the
  // paceTimeMs comment above for why gap detection now also affects pace.
  const gapDetectionEnabledRef = useRef<boolean>(true);
  // CODE_REVIEW_TODO Task 4: mirror of showMovingTime for use inside the
  // 'saved' event handler (set up once at mount) so it can read the latest
  // value at save time without stale-closure issues. Affects which time
  // base (movingMs vs elapsedMs) is used for the saved-card pace display.
  const showMovingTimeRef = useRef<boolean>(false);
  // L24 fix: track the last 'duration' event's sequence number so we can
  // ignore out-of-order events (which were causing the displayed timer to
  // occasionally jump backwards by ~1 s when a getState() poll delivered
  // an older elapsedMs value just after a duration event).
  const lastDurationSeqRef = useRef<number>(0);
  useEffect(() => { movingMsRef.current = movingMs; }, [movingMs]);
  useEffect(() => { elapsedMsRef.current = elapsedMs; }, [elapsedMs]);
  useEffect(() => { autoPauseEnabledRef.current = autoPauseEnabled; }, [autoPauseEnabled]);
  useEffect(() => { gapDetectionEnabledRef.current = gapDetectionEnabled; }, [gapDetectionEnabled]);
  // Task 4: keep showMovingTimeRef in sync so the 'saved' handler (set up
  // once at mount) can read the latest value at save time.
  useEffect(() => { showMovingTimeRef.current = showMovingTime; }, [showMovingTime]);
  // U10: keep isAutoPausedRef in sync so the 'location' handler (set up once
  // at mount) can read the latest value without stale-closure issues.
  useEffect(() => { isAutoPausedRef.current = isAutoPaused; }, [isAutoPaused]);

  // Sync state from native via getState(). Called on mount, on foreground, and every 2s.
  const syncStateFromNative = useCallback(async () => {
    try {
      const state: GpsFullState = await GpsRecorder.getState();
      if (state.isRecording) {
        // U18: update recordingStateRef synchronously alongside the state
        // setter so the 'gnss' / 'location' handlers read the right value.
        setRecordingState((prev) => {
          const next = prev === 'stopping' ? prev : 'recording';
          recordingStateRef.current = next;
          return next;
        });
        // U8: setPointCount(state.pointCount) removed — unused state.
        // L24 fix: don't let a getState() poll overwrite elapsedMs with an
        // older value. The duration tick (1 Hz) is the authoritative source
        // for elapsedMs; the poll is a fallback for when events are dropped.
        // If the poll's elapsedMs is less than what we're already showing,
        // ignore it (a newer duration event will arrive within a second).
        setElapsedMs((prev) => (state.elapsedMs >= prev ? state.elapsedMs : prev));
        if (typeof state.distance === 'number') setDistance(state.distance);
        if (state.fixType) setFixType(state.fixType);
        // Phase 1/3/4: sync auto-pause / signal-lost / moving-time from native.
        if (typeof state.isAutoPaused === 'boolean') setIsAutoPaused(state.isAutoPaused);
        if (typeof state.signalLost === 'boolean') setSignalLost(state.signalLost);
        if (typeof state.movingMs === 'number') setMovingMs(state.movingMs);
        if (state.lastFix) {
          setAccuracy(state.lastFix.accuracy);
          setCurrentSpeed(state.lastFix.speed);
        }
        // U13: startTimeRef assignment removed — dead code.
      } else {
        setRecordingState((prev) => {
          const next = prev === 'stopping' ? prev : 'idle';
          recordingStateRef.current = next;
          return next;
        });
      }
    } catch {
      // ignore — will retry on next poll
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        // Auto-request permissions on first launch.
        let granted = await GpsRecorder.hasPermissions();
        if (!granted) {
          await GpsRecorder.requestPermissions();
          // U23: wrap r in a 0-arg arrow so setTimeout's (...args: any[])=>void
          // type is satisfied under strict mode (r itself expects 1 arg).
          await new Promise<void>((r) => setTimeout(() => r(), 800));
          granted = await GpsRecorder.hasPermissions();
        }
        if (!mounted) return;
        setHasPermissions(granted);

        // Load the post-process setting from native prefs.
        try {
          const pp = await GpsRecorder.getPostProcessEnabled();
          if (mounted) setPostProcessEnabled(pp);
        } catch { /* ignore */ }

        // Load the Gaussian-smoothing setting from native prefs.
        try {
          const gs = await GpsRecorder.getGaussianSmoothingEnabled();
          if (mounted) setGaussianSmoothingEnabled(gs);
        } catch { /* ignore */ }

        // Phase 1: load the auto-pause setting from native prefs.
        try {
          const ap = await GpsRecorder.getAutoPauseEnabled();
          if (mounted) setAutoPauseEnabled(ap);
        } catch { /* ignore */ }

        // Phase 4: load the gap-detection setting from native prefs.
        // Default is true (the previous APK always ran gap detection), so if
        // the native side returns false here it's a real user choice.
        try {
          const gd = await GpsRecorder.getGapDetectionEnabled();
          if (mounted) setGapDetectionEnabled(gd);
        } catch { /* ignore */ }

        // CODE_REVIEW_TODO Task 4: load the show-moving-time display
        // preference. Default is false (legacy wall-clock display).
        try {
          const smt = await GpsRecorder.getShowMovingTimeEnabled();
          if (mounted) setShowMovingTime(smt);
        } catch { /* ignore */ }

        // Load the three data-reduction filter settings from native prefs.
        // Each has a boolean enabled flag + a numeric parameter.
        try {
          const rde = await GpsRecorder.getRadialDistanceFilterEnabled();
          if (mounted) setRadialDistanceFilterEnabled(rde);
          const rdt = await GpsRecorder.getRadialDistanceThresholdM();
          if (mounted) setRadialDistanceThresholdM(rdt);
        } catch { /* ignore */ }
        try {
          const tse = await GpsRecorder.getTimeSamplingEnabled();
          if (mounted) setTimeSamplingEnabled(tse);
          const tsn = await GpsRecorder.getTimeSamplingN();
          if (mounted) setTimeSamplingN(tsn);
        } catch { /* ignore */ }
        try {
          const dpe = await GpsRecorder.getDouglasPeuckerEnabled();
          if (mounted) setDouglasPeuckerEnabled(dpe);
          const dpeps = await GpsRecorder.getDouglasPeuckerEpsilonM();
          if (mounted) setDouglasPeuckerEpsilonM(dpeps);
        } catch { /* ignore */ }

        // Start the always-on GNSS monitor so the UI shows fix status even
        // before recording starts.
        if (granted) {
          try { await GpsRecorder.startGnssMonitor(); } catch { /* ignore */ }
        }
        await syncStateFromNative();
      } catch {
        // ignore
      }
    })();

    // Event subscriptions (real-time updates)
    const subs = [
      subscribe('gnss', (ev: GpsGnssEvent) => {
        // The monitor's status is the source of truth for the GNSS pill.
        setFixType(ev.fixType);
        setAccuracy(ev.accuracy);
        setSatellitesUsed(ev.satellitesUsed);
        setSatellitesInView(ev.satellitesInView);
        setHasFix(ev.hasFix);
        // While idle (not recording), the monitor's speed is also the best
        // current-speed signal we have. While recording, the 'location' event
        // overrides it.
        if (recordingStateRef.current !== 'recording') {
          setCurrentSpeed(ev.speed);
          // U4: also push the GNSS speed into the smoothing window when
          // idle so the displayed pace uses the smoothed average (no more
          // 4:30 → 6:10 flicker). While recording, the 'location' event
          // is the source of truth — we DON'T push gnss speeds then to
          // avoid double-counting.
          if (ev.speed != null) {
            const w = recentSpeedsRef.current;
            w.push(ev.speed);
            if (w.length > SPEED_WINDOW) w.shift();
            forceRerender();
          }
        }
      }),
      subscribe('location', (ev: GpsLocationEvent) => {
        // Recording-time updates from the service.
        // U8: setPointCount(ev.pointCount) removed — unused state.
        if (typeof ev.distance === 'number') setDistance(ev.distance);
        if (ev.fixType) setFixType(ev.fixType);
        if (ev.accuracy != null) setAccuracy(ev.accuracy);
        // U10: don't update currentSpeed while auto-paused — the service
        // still emits location events (with the paused fix), but the
        // underlying state shouldn't change. Read isAutoPaused from a ref
        // to avoid stale-closure issues.
        if (ev.speed != null && !isAutoPausedRef.current) {
          setCurrentSpeed(ev.speed);
          // Push into the smoothing window. We accept every fix here (even
          // slow / zero ones) so the window correctly reflects "user is
          // standing still" — the smoothed pace helper returns null when
          // the window average is below the standing-still threshold.
          const w = recentSpeedsRef.current;
          w.push(ev.speed);
          if (w.length > SPEED_WINDOW) w.shift();
          // U4: force a re-render so the smoothed pace display updates
          // immediately. The push above mutated the ref's array in-place,
          // which React doesn't see — without this the rendered pace would
          // be stale until the next setState.
          forceRerender();
        }
        setHasFix(ev.fixType !== 'no fix');
        // Phase 1/3/4: live auto-pause / signal-lost / moving-time.
        if (typeof ev.isAutoPaused === 'boolean') setIsAutoPaused(ev.isAutoPaused);
        if (typeof ev.signalLost === 'boolean') setSignalLost(ev.signalLost);
        if (typeof ev.movingMs === 'number') setMovingMs(ev.movingMs);
      }),
      subscribe('duration', (ev) => {
        // L24 fix: ignore out-of-order duration events using the
        // monotonically increasing sequence number. The state poll
        // (syncStateFromNative, every 2 s) also sets elapsedMs, and the
        // two paths can deliver values out of order — causing the
        // displayed timer to occasionally jump backwards by ~1 s.
        //
        // We track the last-processed seq in a ref; any event with a seq
        // <= the last one is silently dropped. The getState() poll is
        // also gated to not overwrite elapsedMs if its value is less than
        // the current value (see syncStateFromNative).
        if (typeof ev.seq === 'number' && ev.seq <= lastDurationSeqRef.current) {
          return;
        }
        if (typeof ev.seq === 'number') {
          lastDurationSeqRef.current = ev.seq;
        }
        setElapsedMs(ev.elapsedMs);
        // U13: startTimeRef assignment removed — dead code.
        // L8 fix: prefer the duration event's movingMs over the (stale)
        // location event's movingMs. The duration tick fires every second,
        // so the displayed avg pace no longer oscillates between the live
        // duration tick and the much-less-frequent location event.
        if (typeof ev.movingMs === 'number') {
          setMovingMs(ev.movingMs);
        }
      }),
      subscribe('state', (ev: GpsStateEvent) => {
        if (ev.isRecording) {
          // U18: update ref synchronously.
          recordingStateRef.current = 'recording';
          setRecordingState('recording');
          // U8: setPointCount(ev.pointCount) removed — unused state.
          setElapsedMs(ev.elapsedMs);
          // U13: startTimeRef assignment removed — dead code.
          // Phase 1/3/4: sync live pause / signal / moving-time on state
          // transitions (e.g. when the watchdog fires or auto-pause toggles).
          if (typeof ev.isAutoPaused === 'boolean') setIsAutoPaused(ev.isAutoPaused);
          if (typeof ev.signalLost === 'boolean') setSignalLost(ev.signalLost);
          if (typeof ev.movingMs === 'number') setMovingMs(ev.movingMs);
        } else {
          // U18: update ref synchronously.
          recordingStateRef.current = 'idle';
          setRecordingState('idle');
          // U8: setPointCount(0) removed — unused state.
          setElapsedMs(0);
          setDistance(0);
          setCurrentSpeed(null);
          setFixType('no fix');
          setHasFix(false);
          // Phase 1/3/4: reset live state when recording stops.
          setIsAutoPaused(false);
          setSignalLost(false);
          setMovingMs(0);
          // U13: startTimeRef reset removed — dead code.
          // Clear the pace-smoothing window so a fresh recording starts
          // with no stale speeds from the previous run.
          recentSpeedsRef.current = [];
        }
      }),
      subscribe('saved', (ev: GpsSavedEvent) => {
        // U16: cancel the 1 s fallback syncStateFromNative() that handleStop
        // scheduled — the 'saved' event has arrived, so we don't need the
        // fallback and don't want it to fire after we've already transitioned
        // to 'idle' (would cause a brief flicker back to 'stopping').
        if (stopTimeoutRef.current != null) {
          clearTimeout(stopTimeoutRef.current);
          stopTimeoutRef.current = null;
        }
        // Snapshot the live timing values BEFORE we reset them, so the
        // saved card can show the post-save average pace over the final
        // distance / moving time. We read from refs because this closure
        // is set up once at mount and would otherwise capture stale values.
        setLastSavedMovingMs(movingMsRef.current);
        setLastSavedElapsedMs(elapsedMsRef.current);
        // U3: snapshot the toggle state at save time so the saved card's
        // pace computation is stable — the user can flip auto-pause / gap
        // detection AFTER the save (in preparation for the next run) and
        // the just-saved card must not recompute its pace under the new
        // toggle state.
        setLastSavedSettings({
          autoPauseEnabled: autoPauseEnabledRef.current,
          gapDetectionEnabled: gapDetectionEnabledRef.current,
          // CODE_REVIEW_TODO Task 4: also snapshot showMovingTime so the
          // saved card's pace uses the same time base the user was looking
          // at when they stopped the recording.
          showMovingTime: showMovingTimeRef.current,
        });
        setLastSavedPath(ev.filePath);
        // The native side sends the post-save distance (recomputed from the
        // saved GPX file, post-smoothing) so the UI shows the true track
        // length. Negative means "not available" — keep the live distance.
        // U23: removed the (ev as any).finalDistanceM cast — the
        // GpsSavedEvent type in NativeGpsRecorder.ts already declares
        // finalDistanceM?: number, so the cast was unnecessary.
        const fd = ev.finalDistanceM;
        setLastSavedDistance(typeof fd === 'number' && fd >= 0 ? fd : null);
        // U8: setPointCount(0) removed — unused state.
        setElapsedMs(0);
        setDistance(0);
        setCurrentSpeed(null);
        setFixType('no fix');
        setHasFix(false);
        // U18: update ref synchronously.
        recordingStateRef.current = 'idle';
        setRecordingState('idle');
        // Phase 1/3/4: clear live pause / signal / moving-time after save.
        setIsAutoPaused(false);
        setSignalLost(false);
        setMovingMs(0);
        // U13: startTimeRef reset removed — dead code.
        // Clear the pace-smoothing window for the next recording.
        recentSpeedsRef.current = [];
      }),
      subscribe('error', (ev) => {
        // L10 fix / U17: only reset the UI to idle on FATAL errors.
        // Non-fatal errors (e.g. distance recompute failed, or
        // finalizeGpxFile threw after the GPX was already written) are
        // informational — the recording may still be running OR may have
        // already completed normally. Resetting to idle on a non-fatal
        // error would either:
        //   (a) let the user press START while a recording is in progress,
        //       losing the in-progress track; or
        //   (b) skip showing the saved card (because we'd jump from
        //       'stopping' straight to 'idle' before the 'saved' event
        //       arrives).
        // If a non-fatal error occurs during finalize, the 'saved' event
        // still arrives (with the file path) and the saved card is shown
        // normally — the user sees the error message AND the saved card.
        setErrorMsg(ev.message);
        if (ev.fatal) {
          // U18: update ref synchronously.
          recordingStateRef.current = 'idle';
          setRecordingState('idle');
        }
      }),
    ];

    // Re-sync when coming back to foreground
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        syncStateFromNative();
        // U6: add .catch() so an unhandled promise rejection doesn't fire
        // if hasPermissions() throws (e.g. native module not yet ready on
        // very first foreground event during cold start).
        GpsRecorder.hasPermissions().then(async (g) => {
          setHasPermissions(g);
          if (g) {
            try { await GpsRecorder.startGnssMonitor(); } catch { /* ignore */ }
          }
        }).catch(() => { /* permission check failed, will retry on next AppState change */ });
      }
    });

    // Polling fallback: REMOVED from the mount effect (was always-on, wasting
    // battery when idle). Replaced by the recording-gated useEffect below
    // (U14) that only runs the 2 s poll while a recording is in progress.
    // When idle, the 'gnss' event already keeps the UI fresh.

    return () => {
      mounted = false;
      subs.forEach((s) => s.remove());
      appStateSub.remove();
      // U14: no pollInterval to clear here — that's handled by the
      // recording-gated useEffect below.
      // U6: stopGnssMonitor() returns a Promise — wrapping it in a
      // try/catch would NOT catch an async rejection. Use .catch() so an
      // unhandled promise rejection doesn't fire if the native module
      // rejects during teardown.
      GpsRecorder.stopGnssMonitor().catch(() => { /* ignore */ });
    };
  }, [syncStateFromNative]); // NOTE: recordingState intentionally omitted — see recordingStateRef.

  // U14: 2-second syncStateFromNative polling, gated by recording state.
  // The original always-on setInterval ran every 2 s for the entire app
  // lifetime — wasting battery when idle (the 'gnss' event already keeps
  // the UI fresh). Now we only poll while a recording is in progress, so
  // the JS-native bridge isn't crossed every 2 s while the user is just
  // looking at the idle screen.
  useEffect(() => {
    if (recordingState !== 'recording') return;
    const id = setInterval(() => {
      syncStateFromNative();
    }, 2000);
    return () => clearInterval(id);
  }, [recordingState, syncStateFromNative]);

  const handleStart = useCallback(async () => {
    setErrorMsg(null);
    try {
      let granted = await GpsRecorder.hasPermissions();
      if (!granted) {
        // U1: show a spinner overlay with a Cancel button while the system
        // permission dialog is on screen. requestPermissions() resolves
        // only after the user taps Allow or Deny (L9 fix), so we just await
        // it — no 30-second polling loop, no JS thread blocking. The cancel
        // button lets the user bail out without waiting for the dialog.
        cancelPermissionWaitRef.current = false;
        setWaitingForPermissions(true);
        try {
          granted = await GpsRecorder.requestPermissions();
        } finally {
          setWaitingForPermissions(false);
        }
        // If the user pressed "Отмена" while the dialog was up, bail out
        // without proceeding to startRecording — return to idle silently.
        if (cancelPermissionWaitRef.current) {
          return;
        }
        setHasPermissions(granted);
        if (granted) {
          try { await GpsRecorder.startGnssMonitor(); } catch { /* ignore */ }
        }
      }

      if (!granted) {
        setErrorMsg(
          'Location and notification permissions are required. Please grant them in Android Settings.'
        );
        return;
      }

      // U12: only show the battery-optimization system dialog ONCE per app
      // session. If the user denied it, a warning banner is shown above
      // the START button (rendered below) with a tap action that re-opens
      // the dialog manually.
      if (!hasAskedBatteryOptRef.current) {
        hasAskedBatteryOptRef.current = true;
        try {
          const batteryGranted = await GpsRecorder.requestIgnoreBatteryOptimizations();
          setBatteryOptDenied(!batteryGranted);
        } catch {
          setBatteryOptDenied(true);
        }
      }

      setElapsedMs(0);
      // U8: setPointCount(0) removed — unused state.
      setDistance(0);
      setCurrentSpeed(null);
      setLastSavedPath(null);
      // U3: clear the save-time settings snapshot so the next recording's
      // saved card gets a fresh snapshot (not the previous run's toggles).
      setLastSavedSettings(null);
      // U13: startTimeRef assignment removed — dead code.
      // Clear the pace-smoothing window for the fresh recording.
      recentSpeedsRef.current = [];

      await GpsRecorder.start();
      // U18: update recordingStateRef SYNCHRONOUSLY before setRecordingState
      // so the 'gnss' event handler (which reads the ref) sees 'recording'
      // immediately. Otherwise the ref would lag behind state by one render
      // and a 'gnss' event arriving in that window could override
      // currentSpeed despite us just having started recording.
      recordingStateRef.current = 'recording';
      setRecordingState('recording');
      syncStateFromNative();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      recordingStateRef.current = 'idle';
      setRecordingState('idle');
    }
  }, [syncStateFromNative]);

  // U1: cancel handler for the permission-wait overlay. Just sets a flag —
  // when requestPermissions() eventually resolves, handleStart checks the
  // flag and returns to idle without proceeding. (We can't actually abort
  // the native permission request, but we can ignore its result.)
  const handleCancelPermissionWait = useCallback(() => {
    cancelPermissionWaitRef.current = true;
    setWaitingForPermissions(false);
  }, []);

  // U12: manual retry for the battery-optimization exemption. Tapping the
  // warning banner re-opens the system dialog. We don't reset
  // hasAskedBatteryOptRef here — that would let a subsequent handleStart
  // auto-prompt again, which we explicitly don't want. This is purely a
  // manual retry path.
  const handleRetryBatteryOpt = useCallback(async () => {
    try {
      const granted = await GpsRecorder.requestIgnoreBatteryOptimizations();
      setBatteryOptDenied(!granted);
    } catch {
      setBatteryOptDenied(true);
    }
  }, []);

  const handleStop = useCallback(async () => {
    setErrorMsg(null);
    // U18: update recordingStateRef SYNCHRONOUSLY before setRecordingState.
    recordingStateRef.current = 'stopping';
    setRecordingState('stopping');
    try {
      await GpsRecorder.stop();
      // U16: track the timeout so the 'saved' event handler can cancel it.
      // Without this, a delayed syncStateFromNative() can fire AFTER the
      // 'saved' event has already transitioned the UI to 'idle' + shown
      // the saved card — causing a brief flicker back to 'stopping'.
      stopTimeoutRef.current = setTimeout(() => {
        stopTimeoutRef.current = null;
        syncStateFromNative();
      }, 1000) as unknown as number;
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      // Revert to 'recording' so the user can try STOP again.
      recordingStateRef.current = 'recording';
      setRecordingState('recording');
    }
  }, [syncStateFromNative]);

  const handleGrantPermissions = useCallback(async () => {
    await GpsRecorder.requestPermissions();
    // U23: wrap r in a 0-arg arrow so setTimeout's (...args: any[])=>void
    // type is satisfied under strict mode (r itself expects 1 arg).
    await new Promise<void>((r) => setTimeout(() => r(), 800));
    const granted = await GpsRecorder.hasPermissions();
    setHasPermissions(granted);
    if (granted) {
      try { await GpsRecorder.startGnssMonitor(); } catch { /* ignore */ }
    }
  }, []);

  const isRecording = recordingState === 'recording';
  const isStopping = recordingState === 'stopping';
  // Settings are locked (read-only) while a recording is in progress so that
  // toggling them mid-recording cannot change the filter / smoothing behaviour
  // halfway through the file.
  const settingsLocked = isRecording || isStopping;
  // U15: re-entrancy guard for settings toggles. Without this, a second tap
  // before the first await resolves would cause the first setX(confirmed)
  // to overwrite the second optimistic update. Each toggle handler checks
  // this ref at entry and bails out if a previous toggle is still in flight.
  const settingsUpdatingRef = useRef<boolean>(false);

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
  }, [postProcessEnabled, settingsLocked]);

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
  }, [gaussianSmoothingEnabled, settingsLocked]);

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
  }, [autoPauseEnabled, settingsLocked]);

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
  }, [gapDetectionEnabled, settingsLocked]);

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
  }, []);

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
  }, [radialDistanceFilterEnabled, settingsLocked]);

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
  }, [radialDistanceThresholdM, settingsLocked]);

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
  }, [timeSamplingEnabled, settingsLocked]);

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
  }, [timeSamplingN, settingsLocked]);

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
  }, [douglasPeuckerEnabled, settingsLocked]);

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
  }, [douglasPeuckerEpsilonM, settingsLocked]);

  // Note: distanceFmt / smoothedSpeed / currentPace / paceTimeMs / avgPace
  // were previously computed here and used by the inlined stats JSX. They
  // are now computed inside <StatsDisplay> (see src/components/StatsDisplay.tsx),
  // which is the only consumer. Keeping them here would be dead code.

  // O14: if the native module is not loaded (e.g. package not registered,
  // or the iOS branch was removed but the JS still ran), the fallback
  // object makes every method a no-op. Without this check the app would
  // launch normally but every button would silently do nothing — confusing.
  // All hooks above run unconditionally so this early return is safe.
  if (!isNativeModuleAvailable) {
    return (
      <View style={styles.nativeMissingContainer}>
        <Text style={styles.nativeMissingTitle}>Нативный модуль не загружен</Text>
        <Text style={styles.nativeMissingBody}>
          Приложение не сможет записывать GPS. Попробуйте переустановить
          приложение.
        </Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <StatusBar barStyle="dark-content" backgroundColor={COLOR.bg} />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* GNSS status pill — always visible, updates live */}
        <GnssPill
          fixType={fixType}
          accuracy={accuracy}
          satellitesUsed={satellitesUsed}
          satellitesInView={satellitesInView}
          hasFix={hasFix}
        />

        {isRecording && signalLost && !isAutoPaused && <SignalLostBanner />}

        <StatsDisplay
          recordingState={recordingState}
          elapsedMs={elapsedMs}
          movingMs={movingMs}
          distance={distance}
          currentSpeed={currentSpeed}
          isAutoPaused={isAutoPaused}
          signalLost={signalLost}
          showMovingTime={showMovingTime}
          autoPauseEnabled={autoPauseEnabled}
          gapDetectionEnabled={gapDetectionEnabled}
          recentSpeedsRef={recentSpeedsRef}
        />

        {batteryOptDenied && !isRecording && !isStopping && (
          <BatteryOptBanner onPress={handleRetryBatteryOpt} />
        )}

        <StartStopButton
          recordingState={recordingState}
          onStart={handleStart}
          onStop={handleStop}
        />

        {/* Settings section header + "locked during recording" notice */}
        <View style={styles.settingsHeader}>
          <Text style={styles.settingsHeaderText}>НАСТРОЙКИ</Text>
          {settingsLocked && (
            <Text style={styles.settingsLockedBadge}>
              {/* U21: expand the badge text so a first-time user knows HOW to
                  unlock — previously just said 'Заблокировано на время записи'
                  with no hint that stopping the recording would unlock it. */}
              🔒 Заблокировано на время записи (остановите, чтобы изменить)
            </Text>
          )}
        </View>

        <ToggleRow
          title="Фильтрация трека на лету"
          subtitle={
            postProcessEnabled
              ? 'Включена: точность ≤ 25 м, скорость ≤ 20 км/ч — выбросы отсекаются при записи'
              : 'Выключена: запись сырых GPS-данных без изменений'
          }
          value={postProcessEnabled}
          onPress={handleTogglePostProcess}
          disabled={settingsLocked}
        />

        <ToggleRow
          title="Сглаживание Гауссом (постобработка)"
          subtitle={
            gaussianSmoothingEnabled
              ? 'Включено: после записи к треку применяется гауссово сглаживание (окно ±5 точек, σ=1.5)'
              : 'Выключено: GPX сохраняется как есть, без финального сглаживания'
          }
          value={gaussianSmoothingEnabled}
          onPress={handleToggleGaussianSmoothing}
          disabled={settingsLocked}
        />

        <ToggleRow
          title="Автопауза при остановке"
          subtitle={
            autoPauseEnabled
              ? 'Включена: пауза при скорости < 0.35 м/с и смещении < 3.5 м за 10 с. Средний темп считается по чистому времени движения'
              : 'Выключена: запись идёт непрерывно, даже когда вы стоите на месте'
          }
          value={autoPauseEnabled}
          onPress={handleToggleAutoPause}
          disabled={settingsLocked}
        />

        <ToggleRow
          title="Разделение трека при потере сигнала"
          subtitle={
            gapDetectionEnabled
              ? 'Включено: нет фиксации > 15 с → новый сегмент <trkseg> и баннер "ПОТЕРЯ СИГНАЛА". Расстояние через разрыв не считается'
              : 'Выключено: провалы сигнала игнорируются, трек пишётся одним сегментом (как в прежних версиях)'
          }
          value={gapDetectionEnabled}
          onPress={handleToggleGapDetection}
          disabled={settingsLocked}
        />

        <ToggleRow
          title="Показывать время в движении"
          subtitle={
            showMovingTime
              ? 'Включено: верхний таймер и средний темп считаются по чистому времени движения (без учёта пауз и потерь сигнала). Можно менять во время записи.'
              : 'Выключено: верхний таймер и средний темп считаются по общему времени (включая паузы). Можно менять во время записи.'
          }
          value={showMovingTime}
          onPress={handleToggleShowMovingTime}
        />

        {/* ---- Three data-reduction filters (user-requested) ---- */}
        {/*
          Each filter is an independent toggle with a numeric parameter. All
          are locked while a recording is in progress (settingsLocked), so
          the user can only change them between recordings — same rule as the
          other toggles above. The stepper row is always visible (so the user
          can preview / configure the parameter before enabling the filter),
          but its −/+ buttons are disabled when the toggle is off OR when
          settings are locked.

          1. Radial distance filter (on-the-fly): drop any fix closer than X
             meters to the last kept point. Default X = 5 m.
          2. Time sampling (on-the-fly): keep every N-th fix. Default N = 5
             (≈ one fix every 5 s at 1 Hz).
          3. Douglas-Peucker (post-processing): simplify the saved track by
             dropping points whose perpendicular distance from the segment
             line is < epsilon meters. Default epsilon = 5 m. Applied AFTER
             Gaussian smoothing if both are on.
        */}

        <FilterSettingGroup
          title="Радиальный фильтр (на лету)"
          subtitleOn={`Включён: точка пропускается, если она ближе ${radialDistanceThresholdM} м к последней сохранённой`}
          subtitleOff="Выключен: каждая принятая точка сохраняется в трек"
          value={radialDistanceFilterEnabled}
          onToggle={handleToggleRadialDistanceFilter}
          stepperLabel="Мин. расстояние"
          stepperValue={radialDistanceThresholdM}
          stepperUnit="м"
          stepperMin={0}
          stepperMax={1000}
          onDecrement={() => handleStepperRadialThreshold(-1)}
          onIncrement={() => handleStepperRadialThreshold(+1)}
          settingsLocked={settingsLocked}
        />

<FilterSettingGroup
          title="Децимация по времени (на лету)"
          subtitleOn={`Включена: сохраняется каждая ${timeSamplingN}-я точка (≈ раз в ${timeSamplingN} с при 1 Гц)`}
          subtitleOff="Выключена: сохраняются все принятые точки"
          value={timeSamplingEnabled}
          onToggle={handleToggleTimeSampling}
          stepperLabel="Шаг N"
          stepperValue={timeSamplingN}
          stepperUnit={pluralRu(timeSamplingN, ['точка', 'точки', 'точек'])}
          stepperMin={1}
          stepperMax={60}
          onDecrement={() => handleStepperTimeSamplingN(-1)}
          onIncrement={() => handleStepperTimeSamplingN(+1)}
          settingsLocked={settingsLocked}
        />

<FilterSettingGroup
          title="Douglas-Peucker (постобработка)"
          subtitleOn={`Включён: трек упрощается, точки ближе ${douglasPeuckerEpsilonM} м от линии сегмента удаляются`}
          subtitleOff="Выключен: GPX сохраняется как есть, без финального упрощения"
          value={douglasPeuckerEnabled}
          onToggle={handleToggleDouglasPeucker}
          stepperLabel="Эпсилон (допуск)"
          stepperValue={douglasPeuckerEpsilonM}
          stepperUnit="м"
          stepperMin={0}
          stepperMax={500}
          onDecrement={() => handleStepperDouglasPeuckerEpsilon(-1)}
          onIncrement={() => handleStepperDouglasPeuckerEpsilon(+1)}
          settingsLocked={settingsLocked}
        />{/* CODE_REVIEW_TODO Task 3: over-filter warning banner.
            When all three data-reduction filters (radial distance, time
            sampling, Douglas-Peucker) are enabled simultaneously, the
            track becomes extremely sparse — for a hiker at 1 m/s, this
            can lose track corners. The warning is informational only:
            it does NOT block the user from enabling all three (they may
            have a legitimate reason, e.g. recording a long bike ride
            where aggressive simplification is desired). The banner
            appears directly below the three filter settings and uses
            the existing amber/warning styling convention (matches the
            battery-optimization banner). Updates live as toggles flip. */}
        {radialDistanceFilterEnabled &&
          timeSamplingEnabled &&
          douglasPeuckerEnabled && <OverFilterWarning />}

        {!hasPermissions && (
          <Pressable style={styles.permissionButton} onPress={handleGrantPermissions}>
            <Text style={styles.permissionButtonText}>
              Разрешить доступ к местоположению и уведомлениям
            </Text>
          </Pressable>
        )}

        {lastSavedPath && (
          <SavedCard
            path={lastSavedPath}
            distance={lastSavedDistance}
            movingMs={lastSavedMovingMs}
            elapsedMs={lastSavedElapsedMs}
            settings={lastSavedSettings}
            onDismiss={() => setLastSavedPath(null)}
          />
        )}

        {errorMsg && (
          <ErrorCard
            message={errorMsg}
            hasPermissions={hasPermissions}
            onDismiss={() => setErrorMsg(null)}
            onOpenSettings={() => {
              GpsRecorder.openAppSettings().catch(() => { /* ignore */ });
            }}
          />
        )}

        <View style={styles.footerNote}>
          <Text style={styles.footerText}>
            Запись идёт в foreground service и продолжается, когда приложение
            свёрнуто или смахнуто. Остановить можно из уведомления или кнопкой
            выше. GPX-файлы сохраняются в общую папку Downloads/trck.
          </Text>
        </View>
      </ScrollView>

      <PermissionWaitOverlay
        visible={waitingForPermissions}
        onCancel={handleCancelPermissionWait}
      />

      <StopOverlay visible={isStopping} />
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLOR.bg },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 60,
  },
  // ---- Status row ----
  // Green when recording (active = good, matches the GNSS pill colour scheme).
  // Grey when idle. Amber when auto-paused. Red is reserved for the STOP
  // button + signal-lost banner so the user doesn't read a red dot as
  // "something is wrong" while a recording is happily in progress.
  // Phase 3: amber dot shown while auto-pause is active.
  // ---- Phase 3: auto-pause badge (shown below the TIME stat) ----
  // ---- Phase 4: signal-lost banner ----
  // ---- Big button ----
  // U12: battery-optimization warning banner.
  // ---- CODE_REVIEW_TODO Task 3: over-filter warning banner ----
  // Shown directly below the three data-reduction filter settings when ALL
  // three are enabled simultaneously. Uses the existing amber palette
  // (COLOR.pauseBg / pauseBorder / pauseAccent — same as the battery-opt
  // banner above) for visual consistency with the project's "warning"
  // convention. The left-border accent + title/body layout mirrors the
  // signal-lost banner (red variant) for a familiar look.
  // ---- Post-processing toggle ----
  // Variant for toggle rows that are the TOP half of a settingGroup (toggle
  // + stepper card). Removes the bottom margin and rounds only the top
  // corners so the stepper row below visually attaches to it.
  // Visual "locked" state — used when recording is in progress so the toggles
  // are visibly disabled. We deliberately keep the row's on/off color so the
  // user can still tell which settings are active; we only dim the whole row
  // (opacity) and override the background to a neutral grey so the row looks
  // "frozen" rather than "off".
  // NOTE: we intentionally do NOT override the switch color when locked.
  // The row-level `opacity: 0.55` already conveys "disabled"; forcing the
  // switch to grey made enabled-but-locked toggles look "off" mid-recording,
  // which was one of the wonky-UI complaints.
  // ---- Setting group (toggle + stepper card) ----
  // Wraps a toggle row + stepper row so they read as one "card". The
  // marginBottom here replaces the per-row marginBottom (which is removed
  // by toggleRowGrouped on the top row, and absent on StepperRow).
  // ---- Settings section header + locked badge ----
  settingsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    marginTop: 4,
    flexWrap: 'wrap',
    gap: 8,
  },
  settingsHeaderText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLOR.secondary,
    letterSpacing: 2,
  },
  settingsLockedBadge: {
    fontSize: 10,
    fontWeight: '600',
    color: COLOR.accentStop,
    backgroundColor: '#FEF2F2',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
  // ---- Permission button ----
  permissionButton: {
    backgroundColor: '#F3F4F6', borderRadius: 12, paddingVertical: 14,
    alignItems: 'center', marginBottom: 16, borderWidth: 1, borderColor: COLOR.divider,
  },
  permissionButtonText: { color: COLOR.primary, fontSize: 14, fontWeight: '600' },
  // ---- Saved / error cards ----
  // U19: shared row layout for the saved/error card title + dismiss button.
  // U19: shared dismiss (✕) button used by both the saved card and the
  // error card. Small, neutral-coloured, top-right of the card.
  // Final distance + pace line shown on the saved card. Slightly larger and
  // bolder than the path so the user notices it.
  // U2: "Открыть настройки" button shown inside the error card when the user
  // is missing permissions. Tapping it calls GpsRecorder.openAppSettings(),
  // which opens the Android system app-details page (where the user can
  // grant location / notification permissions manually).
  // ---- Footer ----
  footerNote: { marginTop: 8 },
  footerText: {
    color: '#9CA3AF', fontSize: 12, lineHeight: 18, textAlign: 'center',
  },
  // ---- U1: permission-wait overlay ----
  // Full-screen semi-transparent overlay so the user can't tap anything else
  // while waiting for the system permission dialog. Centers a card with a
  // spinner, an explanatory line, and a Cancel button.
  // O14: full-screen "native module not loaded" fallback.
  nativeMissingContainer: {
    flex: 1,
    backgroundColor: COLOR.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  nativeMissingTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: COLOR.errorText,
    marginBottom: 16,
    textAlign: 'center',
  },
  nativeMissingBody: {
    fontSize: 14,
    color: COLOR.secondary,
    textAlign: 'center',
    lineHeight: 20,
  },
});

export default App;
