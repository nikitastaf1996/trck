/**
 * recordingStore — the single source of truth for everything that used to
 * live in App.tsx's hooks (useRecordingSession, useRecordingEventHandlers,
 * useRecordingControls, useGnssMonitor, usePermissions).
 *
 * Why a store, not hooks:
 *   The previous design smeared recording state across five hooks + two
 *   factory files + a forest of mirror refs. The mirror refs existed
 *   because once-subscribed event handlers (set up in a mount effect)
 *   closed over stale React state — the only way to read fresh state from
 *   inside those closures was to manually keep a ref in sync (U18), or to
 *   `forceRerender` after mutating a ref's array in place (U4). Both
 *   patterns are gone now: handlers read `useRecordingStore.getState()`
 *   at call time, which is always fresh. No mirror refs, no
 *   forceRerender, no 19-param hook signatures.
 *
 * What's in here:
 *   - The recording state machine: 'idle' | 'recording' | 'stopping'.
 *   - Live telemetry from native events: elapsedMs, distance, currentSpeed,
 *     isAutoPaused, signalLost, movingMs.
 *   - GNSS status (always-on monitor): fixType, accuracy, satellitesUsed/InView, hasFix.
 *   - Permission state: hasPermissions, waitingForPermissions, batteryOptDenied.
 *   - Saved-card snapshot: lastSavedPath/Distance/MovingMs/ElapsedMs/Settings.
 *   - Error message state.
 *   - A sliding window of recent GPS speeds for smoothed pace display.
 *
 * What's NOT in here:
 *   - The 11 user-facing settings — those live in settingsStore.ts.
 *   - The native module itself — this store calls GpsRecorder.* and
 *     reduces the results into state.
 *   - The 2-second syncStateFromNative polling loop, the 1s/15s stop
 *     fallbacks, and the AppState listener — those are wiring concerns
 *     that belong in App.tsx's mount effect (they need React lifecycle).
 *
 * The store is created with `create()` from zustand. Selectors are
 * `useRecordingStore(s => s.foo)` — zustand handles shallow-equal memo
 * for object selectors. The store's `getState()` is also stable, so
 * non-React code (e.g. the event handlers wired up once in App.tsx's
 * mount effect) can read fresh state without subscribing.
 */

import { create } from 'zustand';
import {
  GpsRecorder,
  subscribe,
  type GpsLocationEvent,
  type GpsDurationEvent,
  type GpsStateEvent,
  type GpsSavedEvent,
  type GpsErrorEvent,
  type GpsGnssEvent,
  type GpsFixType,
  type GpsFullState,
} from '../NativeGpsRecorder';
import type { RecordingState } from '../styles';

// Sliding window of the most recent GPS speeds (m/s) for smoothed pace.
// 5 entries ≈ 5 s at 1 Hz — short enough to be responsive, long enough
// to smooth out single-fix outliers.
export const SPEED_WINDOW = 5;

// 1 s soft fallback: if the 'saved' event doesn't arrive within 1 s of
// handleStop, poll getState() once to recover the UI to 'idle'.
const STOP_FALLBACK_MS = 1_000;

// 15 s hard fallback: if neither the 'saved' event nor the 1 s poll has
// recovered the UI, forcibly reset to 'idle' so the "Сохранение GPX…"
// overlay doesn't stay on screen forever. Chosen to be long enough that
// a normal GPX finalize (Gaussian + Douglas-Peucker on a multi-hour
// track) completes well within it.
const STOP_HARD_FALLBACK_MS = 15_000;

// U23: 800 ms wait after requestPermissions() so the native side has
// time to settle before we re-check hasPermissions().
const PERMISSION_SETTLE_MS = 800;

export type SavedSettingsSnapshot = {
  autoPauseEnabled: boolean;
  gapDetectionEnabled: boolean;
  showMovingTime: boolean;
};

export type RecordingStoreState = {
  // ---- Recording state machine ----
  recordingState: RecordingState;

  // ---- Live telemetry (from native events) ----
  elapsedMs: number;
  distance: number;
  currentSpeed: number | null;
  isAutoPaused: boolean;
  signalLost: boolean;
  movingMs: number;

  // ---- GNSS status (always-on monitor) ----
  fixType: GpsFixType;
  accuracy: number | null;
  satellitesUsed: number;
  satellitesInView: number;
  hasFix: boolean;

  // ---- Permission state ----
  hasPermissions: boolean;
  waitingForPermissions: boolean;
  batteryOptDenied: boolean;
  hasAskedBatteryOpt: boolean; // session-only — true once we've prompted once
  cancelPermissionWait: boolean; // flipped by the overlay's Cancel button

  // ---- Saved-card snapshot (captured at save time, cleared on next START) ----
  lastSavedPath: string | null;
  lastSavedDistance: number | null;
  lastSavedMovingMs: number;
  lastSavedElapsedMs: number;
  lastSavedSettings: SavedSettingsSnapshot | null;

  // ---- Error surface (shared by recording + settings) ----
  errorMsg: string | null;

  // ---- Pace smoothing window ----
  // Mutated via `pushSpeed` (which replaces the array, not in-place) so
  // zustand sees the change and selectors re-run. The previous design
  // mutated in place and used `forceRerender` because React can't see
  // .push()/.shift() — that workaround is gone.
  recentSpeeds: number[];

  // ---- Internal: sequence number for dropping out-of-order 'duration' events ----
  // Exists because the 2 s syncStateFromNative poll and the 1 Hz duration
  // tick can deliver elapsedMs values out of order, which would make the
  // displayed timer occasionally jump backwards by ~1 s.
  lastDurationSeq: number;

  // ---- Actions (called from App.tsx event handlers + UI buttons) ----

  /** Apply a 'location' event from native. */
  applyLocationEvent: (ev: GpsLocationEvent) => void;
  /** Apply a 'duration' event from native (1 Hz tick). */
  applyDurationEvent: (ev: GpsDurationEvent) => void;
  /** Apply a 'state' event from native (recording-start / stop transitions). */
  applyStateEvent: (ev: GpsStateEvent) => void;
  /** Apply a 'saved' event from native (GPX file written). */
  applySavedEvent: (ev: GpsSavedEvent) => void;
  /** Apply an 'error' event from native. fatal=true → reset to idle. */
  applyErrorEvent: (ev: GpsErrorEvent) => void;
  /** Apply a 'gnss' event from native (always-on monitor). */
  applyGnssEvent: (ev: GpsGnssEvent) => void;

  /**
   * Sync state from a getState() poll. Called on mount, on foreground,
   * and every 2 s while recording. The poll is a FALLBACK for when
   * native events are dropped — events are the primary source of truth.
   */
  syncFromNative: (state: GpsFullState) => void;

  /**
   * Push a GNSS speed into the smoothing window when not recording
   * (so the pace display is responsive even before START). While
   * recording, the 'location' event is the source of truth and we
   * don't double-count.
   */
  pushIdleSpeed: (speed: number | null) => void;

  // ---- Recording control ----
  /**
   * handleStart: permission flow + battery-opt prompt + GpsRecorder.start().
   * Throws nothing — errors land in `errorMsg`. Returns the granted flag
   * so the caller can decide whether to start the GNSS monitor.
   */
  handleStart: () => Promise<{ granted: boolean }>;
  /**
   * handleStop: GpsRecorder.stop() + 1 s soft fallback + 15 s hard fallback.
   * The 'saved' event cancels both fallbacks (see applySavedEvent).
   */
  handleStop: () => Promise<void>;

  // ---- Manual permission / battery-opt retry ----
  /** Initial mount-time permission check. Returns the granted flag. */
  initialPermissionCheck: () => Promise<boolean>;
  /** Manual "Разрешить доступ" button. */
  handleGrantPermissions: () => Promise<void>;
  /** Manual battery-opt retry (from the warning banner). */
  handleRetryBatteryOpt: () => Promise<void>;
  /** Cancel button on the permission-wait overlay. */
  handleCancelPermissionWait: () => void;

  // ---- UI actions ----
  dismissSavedCard: () => void;
  dismissError: () => void;
  setHasPermissions: (b: boolean) => void;
  /** Surface an error message (shared with settingsStore for revert-on-error). */
  setError: (msg: string | null) => void;

  // ---- Internal: scheduled by handleStop, cancelled by applySavedEvent ----
  // Exposed on the store so applySavedEvent can clear them. Not for
  // external use.
  _stopFallbackTimer: ReturnType<typeof setTimeout> | null;
  _stopHardFallbackTimer: ReturnType<typeof setTimeout> | null;
};

export const useRecordingStore = create<RecordingStoreState>((set, get) => ({
  // ---- Initial state ----
  recordingState: 'idle',
  elapsedMs: 0,
  distance: 0,
  currentSpeed: null,
  isAutoPaused: false,
  signalLost: false,
  movingMs: 0,
  fixType: 'no fix',
  accuracy: null,
  satellitesUsed: 0,
  satellitesInView: 0,
  hasFix: false,
  hasPermissions: false,
  waitingForPermissions: false,
  batteryOptDenied: false,
  hasAskedBatteryOpt: false,
  cancelPermissionWait: false,
  lastSavedPath: null,
  lastSavedDistance: null,
  lastSavedMovingMs: 0,
  lastSavedElapsedMs: 0,
  lastSavedSettings: null,
  errorMsg: null,
  recentSpeeds: [],
  lastDurationSeq: 0,
  _stopFallbackTimer: null,
  _stopHardFallbackTimer: null,

  // ---- Event reducers ----

  applyLocationEvent: (ev) => {
    set((s) => {
      // U10: don't update currentSpeed while auto-paused — the service
      // still emits location events with the paused fix, but the
      // underlying state shouldn't change.
      let nextSpeed = s.currentSpeed;
      let nextWindow = s.recentSpeeds;
      if (ev.speed != null && !s.isAutoPaused) {
        nextSpeed = ev.speed;
        // Replace the array (not in-place) so zustand sees the change.
        const w = [...s.recentSpeeds, ev.speed];
        if (w.length > SPEED_WINDOW) w.shift();
        nextWindow = w;
      }
      return {
        distance: typeof ev.distance === 'number' ? ev.distance : s.distance,
        fixType: ev.fixType ?? s.fixType,
        accuracy: ev.accuracy ?? s.accuracy,
        currentSpeed: nextSpeed,
        hasFix: ev.fixType !== 'no fix',
        isAutoPaused: typeof ev.isAutoPaused === 'boolean' ? ev.isAutoPaused : s.isAutoPaused,
        signalLost: typeof ev.signalLost === 'boolean' ? ev.signalLost : s.signalLost,
        movingMs: typeof ev.movingMs === 'number' ? ev.movingMs : s.movingMs,
        recentSpeeds: nextWindow,
      };
    });
  },

  applyDurationEvent: (ev) => {
    // L24: drop out-of-order duration events using the seq counter.
    // The 2 s syncFromNative poll and the 1 Hz duration tick can deliver
    // values out of order, which would make the displayed timer jump
    // backwards by ~1 s.
    if (typeof ev.seq === 'number' && ev.seq <= get().lastDurationSeq) {
      return;
    }
    set((s) => ({
      lastDurationSeq: typeof ev.seq === 'number' ? ev.seq : s.lastDurationSeq,
      elapsedMs: ev.elapsedMs,
      // L8: prefer the duration event's movingMs over the (stale)
      // location event's movingMs. The duration tick fires every second,
      // so the displayed avg pace no longer oscillates between the live
      // duration tick and the much-less-frequent location event.
      movingMs: typeof ev.movingMs === 'number' ? ev.movingMs : s.movingMs,
    }));
  },

  applyStateEvent: (ev) => {
    if (ev.isRecording) {
      set({
        recordingState: 'recording',
        elapsedMs: ev.elapsedMs,
        isAutoPaused: typeof ev.isAutoPaused === 'boolean' ? ev.isAutoPaused : get().isAutoPaused,
        signalLost: typeof ev.signalLost === 'boolean' ? ev.signalLost : get().signalLost,
        movingMs: typeof ev.movingMs === 'number' ? ev.movingMs : get().movingMs,
      });
    } else {
      // Recording stopped — reset all live telemetry.
      set({
        recordingState: 'idle',
        elapsedMs: 0,
        distance: 0,
        currentSpeed: null,
        fixType: 'no fix',
        hasFix: false,
        accuracy: null,
        isAutoPaused: false,
        signalLost: false,
        movingMs: 0,
        recentSpeeds: [],
      });
    }
  },

  applySavedEvent: (ev) => {
    // Cancel both stop fallbacks — the 'saved' event has arrived.
    const { _stopFallbackTimer, _stopHardFallbackTimer } = get();
    if (_stopFallbackTimer) {
      clearTimeout(_stopFallbackTimer);
    }
    if (_stopHardFallbackTimer) {
      clearTimeout(_stopHardFallbackTimer);
    }

    // U3 / Task 4: snapshot the settings toggle state at save time so
    // the saved card's pace computation is stable. After a recording
    // ends the settings unlock and the user can flip auto-pause / gap
    // detection to prepare for the next run — without the snapshot,
    // the just-saved card's pace would silently recompute under the
    // new toggle state.
    //
    // We import the settings store lazily (circular-dep avoidance) to
    // read the live values at save time.
    const settingsSnap: SavedSettingsSnapshot = readSettingsSnapshotForSavedCard();

    set((s) => ({
      // Snapshot timing values BEFORE we reset them, so the saved card
      // can show the post-save average pace over the final distance.
      lastSavedMovingMs: s.movingMs,
      lastSavedElapsedMs: s.elapsedMs,
      lastSavedSettings: settingsSnap,
      lastSavedPath: ev.filePath,
      // The native side sends the post-save distance (recomputed from
      // the saved GPX, post-smoothing) so the UI shows the true track
      // length. Negative / undefined means "not available" — keep the
      // live-accumulated distance.
      lastSavedDistance: typeof ev.finalDistanceM === 'number' && ev.finalDistanceM >= 0
        ? ev.finalDistanceM
        : null,
      // Reset live telemetry.
      recordingState: 'idle',
      elapsedMs: 0,
      distance: 0,
      currentSpeed: null,
      fixType: 'no fix',
      hasFix: false,
      accuracy: null,
      isAutoPaused: false,
      signalLost: false,
      movingMs: 0,
      recentSpeeds: [],
      _stopFallbackTimer: null,
      _stopHardFallbackTimer: null,
    }));
  },

  applyErrorEvent: (ev) => {
    // L10 / U17: only reset the UI to idle on FATAL errors. Non-fatal
    // errors (e.g. distance recompute failed, or finalizeGpxFile threw
    // after the GPX was already written) are informational — the
    // recording may still be running OR may have already completed
    // normally. Resetting to idle on a non-fatal error would either:
    //   (a) let the user press START while a recording is in progress,
    //       losing the in-progress track; or
    //   (b) skip showing the saved card (because we'd jump from
    //       'stopping' straight to 'idle' before the 'saved' event arrives).
    if (ev.fatal) {
      set({ errorMsg: ev.message, recordingState: 'idle' });
    } else {
      set({ errorMsg: ev.message });
    }
  },

  applyGnssEvent: (ev) => {
    set({
      fixType: ev.fixType,
      accuracy: ev.accuracy,
      satellitesUsed: ev.satellitesUsed,
      satellitesInView: ev.satellitesInView,
      hasFix: ev.hasFix,
    });
  },

  syncFromNative: (state) => {
    if (state.isRecording) {
      // H4 fix: if we were 'stopping' but the native side is reporting
      // isRecording === true again (e.g. the stop intent was lost and
      // the user started a NEW recording), allow the transition back
      // to 'recording' — the alternative is to stay stuck in 'stopping'
      // forever while the native side is actively recording.
      const prev = get().recordingState;
      const next: RecordingState = prev === 'stopping' ? prev : 'recording';
      set((s) => ({
        recordingState: next,
        // L24: don't let a getState() poll overwrite elapsedMs with an
        // older value. The duration tick (1 Hz) is the authoritative
        // source; the poll is a fallback for when events are dropped.
        elapsedMs: state.elapsedMs >= s.elapsedMs ? state.elapsedMs : s.elapsedMs,
        distance: typeof state.distance === 'number' ? state.distance : s.distance,
        fixType: state.fixType ?? s.fixType,
        isAutoPaused: typeof state.isAutoPaused === 'boolean' ? state.isAutoPaused : s.isAutoPaused,
        signalLost: typeof state.signalLost === 'boolean' ? state.signalLost : s.signalLost,
        movingMs: typeof state.movingMs === 'number' ? state.movingMs : s.movingMs,
        currentSpeed: state.lastFix?.speed ?? s.currentSpeed,
        accuracy: state.lastFix?.accuracy ?? s.accuracy,
      }));
    } else {
      // H4 fix: allow the UI to recover from 'stopping' to 'idle' when
      // the native side confirms it is no longer recording. Previously
      // this branch preserved 'stopping' indefinitely, which left the
      // "Сохранение GPX…" overlay on screen forever if the 'saved'
      // event was never delivered.
      set({ recordingState: 'idle' });
    }
  },

  pushIdleSpeed: (speed) => {
    if (speed == null) {
      set({ currentSpeed: null });
      return;
    }
    set((s) => {
      const w = [...s.recentSpeeds, speed];
      if (w.length > SPEED_WINDOW) w.shift();
      return { currentSpeed: speed, recentSpeeds: w };
    });
  },

  // ---- Recording control ----

  handleStart: async () => {
    set({ errorMsg: null });
    let granted = await GpsRecorder.hasPermissions();
    if (!granted) {
      // U1: show a spinner overlay with a Cancel button while the system
      // permission dialog is on screen. requestPermissions() resolves
      // only after the user taps Allow or Deny.
      set({ cancelPermissionWait: false, waitingForPermissions: true });
      try {
        granted = await GpsRecorder.requestPermissions();
      } finally {
        set({ waitingForPermissions: false });
      }
      // If the user pressed "Отмена" while the dialog was up, bail out
      // without proceeding to startRecording — return to idle silently.
      if (get().cancelPermissionWait) {
        return { granted: false };
      }
      set({ hasPermissions: granted });
    }

    if (!granted) {
      set({
        errorMsg:
          'Location and notification permissions are required. Please grant them in Android Settings.',
      });
      return { granted: false };
    }

    // U12: only show the battery-optimization system dialog ONCE per app
    // session. If the user denied it, a warning banner is shown above
    // the START button with a tap action that re-opens the dialog.
    if (!get().hasAskedBatteryOpt) {
      set({ hasAskedBatteryOpt: true });
      try {
        const batteryGranted = await GpsRecorder.requestIgnoreBatteryOptimizations();
        set({ batteryOptDenied: !batteryGranted });
      } catch {
        set({ batteryOptDenied: true });
      }
    }

    // Clear all live state for a fresh recording.
    set({
      elapsedMs: 0,
      distance: 0,
      currentSpeed: null,
      lastSavedPath: null,
      lastSavedSettings: null,
      isAutoPaused: false,
      signalLost: false,
      movingMs: 0,
      recentSpeeds: [],
      recordingState: 'recording',
    });

    await GpsRecorder.start();
    return { granted: true };
  },

  handleStop: async () => {
    set({ errorMsg: null, recordingState: 'stopping' });
    try {
      await GpsRecorder.stop();

      // U16: 1 s soft fallback — if the 'saved' event doesn't arrive
      // within 1 s, poll getState() once to recover the UI.
      const fallback = setTimeout(() => {
        // syncFromNative is async via GpsRecorder.getState(); we kick
        // it off here. The store update happens when the promise
        // resolves.
        GpsRecorder.getState()
          .then((state) => get().syncFromNative(state))
          .catch(() => { /* ignore — will retry on AppState change */ });
        set({ _stopFallbackTimer: null });
      }, STOP_FALLBACK_MS);
      set({ _stopFallbackTimer: fallback });

      // H4 fix: 15 s hard fallback — if neither 'saved' nor the 1 s
      // poll has recovered the UI, forcibly reset to 'idle' so the
      // "Сохранение GPX…" overlay doesn't stay on screen forever.
      const hardFallback = setTimeout(() => {
        if (get().recordingState === 'stopping') {
          set({ recordingState: 'idle' });
        }
        set({ _stopHardFallbackTimer: null });
      }, STOP_HARD_FALLBACK_MS);
      set({ _stopHardFallbackTimer: hardFallback });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Revert to 'recording' so the user can try STOP again.
      set({ errorMsg: msg, recordingState: 'recording' });
      const { _stopHardFallbackTimer } = get();
      if (_stopHardFallbackTimer) {
        clearTimeout(_stopHardFallbackTimer);
        set({ _stopHardFallbackTimer: null });
      }
    }
  },

  // ---- Manual permission / battery-opt retry ----

  initialPermissionCheck: async () => {
    let granted = await GpsRecorder.hasPermissions();
    if (!granted) {
      await GpsRecorder.requestPermissions();
      // U23: 800 ms settle wait so the native side has time to update.
      await new Promise<void>((r) => setTimeout(() => r(), PERMISSION_SETTLE_MS));
      granted = await GpsRecorder.hasPermissions();
    }
    set({ hasPermissions: granted });
    return granted;
  },

  handleGrantPermissions: async () => {
    await GpsRecorder.requestPermissions();
    await new Promise<void>((r) => setTimeout(() => r(), PERMISSION_SETTLE_MS));
    const granted = await GpsRecorder.hasPermissions();
    set({ hasPermissions: granted });
    if (granted) {
      try { await GpsRecorder.startGnssMonitor(); } catch { /* ignore */ }
    }
  },

  handleRetryBatteryOpt: async () => {
    try {
      const granted = await GpsRecorder.requestIgnoreBatteryOptimizations();
      set({ batteryOptDenied: !granted });
    } catch {
      set({ batteryOptDenied: true });
    }
  },

  handleCancelPermissionWait: () => {
    set({ cancelPermissionWait: true, waitingForPermissions: false });
  },

  // ---- UI actions ----

  dismissSavedCard: () => set({ lastSavedPath: null }),
  dismissError: () => set({ errorMsg: null }),
  setHasPermissions: (b) => set({ hasPermissions: b }),
  setError: (msg) => set({ errorMsg: msg }),
}));

/**
 * Lazy import of the settings store to read the snapshot at save time.
 * Avoids a circular module dependency (settingsStore imports
 * useRecordingStore for `settingsLocked`).
 *
 * Returns the three settings that affect the saved-card pace display.
 * Defaults match the native-side defaults (see GpsRecorderSettings.kt).
 */
function readSettingsSnapshotForSavedCard(): SavedSettingsSnapshot {
  // Lazy require to avoid circular import at module-load time.
  const { useSettingsStore } = require('./settingsStore') as typeof import('./settingsStore');
  const s = useSettingsStore.getState();
  return {
    autoPauseEnabled: s.autoPauseEnabled,
    gapDetectionEnabled: s.gapDetectionEnabled,
    showMovingTime: s.showMovingTime,
  };
}

// ---------------------------------------------------------------------------
// Convenience: subscribe to all 6 native events and dispatch into the store.
// Call this ONCE from App.tsx's mount effect; the returned cleanup function
// tears down all subscriptions. App.tsx no longer needs to wire each event
// individually.
// ---------------------------------------------------------------------------

export type NativeSubscriptionHandle = {
  remove: () => void;
};

export function subscribeAllNativeEvents(): NativeSubscriptionHandle {
  const store = useRecordingStore;
  const subs: NativeSubscriptionHandle[] = [
    subscribe('location', (ev: GpsLocationEvent) => store.getState().applyLocationEvent(ev)),
    subscribe('duration', (ev: GpsDurationEvent) => store.getState().applyDurationEvent(ev)),
    subscribe('state', (ev: GpsStateEvent) => store.getState().applyStateEvent(ev)),
    subscribe('saved', (ev: GpsSavedEvent) => store.getState().applySavedEvent(ev)),
    subscribe('error', (ev: GpsErrorEvent) => store.getState().applyErrorEvent(ev)),
    subscribe('gnss', (ev: GpsGnssEvent) => {
      store.getState().applyGnssEvent(ev);
      // U4: while NOT recording, push the GNSS speed into the smoothing
      // window (so the pace display is smoothed). While recording, the
      // 'location' event is the source of truth — we DON'T push gnss
      // speeds then to avoid double-counting.
      if (store.getState().recordingState !== 'recording') {
        store.getState().pushIdleSpeed(ev.speed);
      }
    }),
  ];
  return {
    remove: () => subs.forEach((s) => s.remove()),
  };
}
