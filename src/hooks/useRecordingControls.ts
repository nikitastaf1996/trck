/**
 * useRecordingControls — pure factory functions for the handleStart and
 * handleStop entry points of useRecordingSession.
 *
 * Extracted in T5 (alongside useRecordingEventHandlers) to keep
 * useRecordingSession.ts under 500 lines. Each factory captures the state
 * setters, refs, and stable callbacks it needs via a params object; the
 * returned async function closes over those captured values exactly as the
 * original inline useCallback bodies did.
 *
 * Behavioural invariants preserved verbatim from the original inline code
 * (see useRecordingSession.ts header for the full list):
 *
 *   - U1: handleStart shows a spinner overlay (controlled by
 *     setWaitingForPermissions) while the system permission dialog is on
 *     screen; the cancel button flips cancelPermissionWaitRef.
 *   - U12: handleStart only shows the battery-optimization system dialog
 *     ONCE per app session (hasAskedBatteryOptRef gates it).
 *   - U3: handleStart clears the save-time settings snapshot so the next
 *     recording's saved card gets a fresh snapshot.
 *   - U18: handleStart / handleStop update recordingStateRef SYNCHRONOUSLY
 *     (before setRecordingState) so the 'gnss' / 'location' handlers (set
 *     up once at mount) read the right value.
 *   - U16: handleStop schedules a 1 s fallback syncStateFromNative() in case
 *     the 'saved' event is delayed or lost; the 'saved' event handler
 *     cancels it via stopTimeoutRef.
 *
 * The factory functions are pure (no React imports beyond the type-only
 * MutableRefObject import) and have no side effects beyond those captured
 * in their params. They are wrapped in useCallback by useRecordingSession
 * so the returned function reference is stable across renders (matching
 * the original behaviour).
 */

import type React from 'react';
import { GpsRecorder } from '../NativeGpsRecorder';
import type { RecordingState } from '../styles';

// ---------------------------------------------------------------------------
// handleStart
// ---------------------------------------------------------------------------

export type HandleStartParams = {
  setErrorMsg: (msg: string | null) => void;
  setRecordingState: React.Dispatch<React.SetStateAction<RecordingState>>;
  setElapsedMs: React.Dispatch<React.SetStateAction<number>>;
  setDistance: (v: number) => void;
  setCurrentSpeed: (v: number | null) => void;
  setLastSavedPath: (v: string | null) => void;
  setLastSavedSettings: (v: { autoPauseEnabled: boolean; gapDetectionEnabled: boolean; showMovingTime: boolean } | null) => void;
  setWaitingForPermissions: (v: boolean) => void;
  setHasPermissions: (g: boolean) => void;
  setBatteryOptDenied: (v: boolean) => void;
  cancelPermissionWaitRef: React.MutableRefObject<boolean>;
  hasAskedBatteryOptRef: React.MutableRefObject<boolean>;
  recordingStateRef: React.MutableRefObject<RecordingState>;
  recentSpeedsRef: React.MutableRefObject<number[]>;
  startMonitor: () => Promise<boolean>;
  syncStateFromNative: () => Promise<void>;
  // Task 9: setters used to clear stale warning flags + moving time on
  // restart. After an error or an auto-pause-active stop, the previous
  // implementation could leave the "АВТОПАУЗА" / "СИГНАЛ ПОТЕРЯН" banners
  // visible for a frame before the first 'state' event from the freshly
  // started recording arrived and cleared them. Explicitly resetting them
  // here ensures a clean visual start.
  setIsAutoPaused: (v: boolean) => void;
  setSignalLost: (v: boolean) => void;
  setMovingMs: (v: number) => void;
};

export function startRecording(p: HandleStartParams) {
  return (async () => {
    p.setErrorMsg(null);
    try {
      let granted = await GpsRecorder.hasPermissions();
      if (!granted) {
        // U1: show a spinner overlay with a Cancel button while the system
        // permission dialog is on screen. requestPermissions() resolves
        // only after the user taps Allow or Deny (L9 fix), so we just await
        // it — no 30-second polling loop, no JS thread blocking. The cancel
        // button lets the user bail out without waiting for the dialog.
        p.cancelPermissionWaitRef.current = false;
        p.setWaitingForPermissions(true);
        try {
          granted = await GpsRecorder.requestPermissions();
        } finally {
          p.setWaitingForPermissions(false);
        }
        // If the user pressed "Отмена" while the dialog was up, bail out
        // without proceeding to startRecording — return to idle silently.
        if (p.cancelPermissionWaitRef.current) {
          return;
        }
        p.setHasPermissions(granted);
        if (granted) {
          try { await p.startMonitor(); } catch { /* ignore */ }
        }
      }

      if (!granted) {
        p.setErrorMsg(
          'Location and notification permissions are required. Please grant them in Android Settings.'
        );
        return;
      }

      // U12: only show the battery-optimization system dialog ONCE per app
      // session. If the user denied it, a warning banner is shown above
      // the START button (rendered in App.tsx) with a tap action that re-
      // opens the dialog manually.
      if (!p.hasAskedBatteryOptRef.current) {
        p.hasAskedBatteryOptRef.current = true;
        try {
          const batteryGranted = await GpsRecorder.requestIgnoreBatteryOptimizations();
          p.setBatteryOptDenied(!batteryGranted);
        } catch {
          p.setBatteryOptDenied(true);
        }
      }

      p.setElapsedMs(0);
      p.setDistance(0);
      p.setCurrentSpeed(null);
      p.setLastSavedPath(null);
      // U3: clear the save-time settings snapshot so the next recording's
      // saved card gets a fresh snapshot (not the previous run's toggles).
      p.setLastSavedSettings(null);
      // Clear the pace-smoothing window for the fresh recording.
      p.recentSpeedsRef.current = [];
      // Task 9 (stale-flag reset): explicitly clear the auto-pause / signal-
      // lost / moving-time flags. After an error-triggered restart, or when
      // the previous recording ended while auto-paused / signal-lost, the
      // native 'state' event for the new recording can take a tick to
      // arrive — without this explicit reset the user would see stale
      // "АВТОПАУЗА" / "СИГНАЛ ПОТЕРЯН" banners and a non-zero movingMs
      // for a frame before the new state event clears them. The native
      // side's startRecording() also resets these (see
      // AutoPauseGapController.reset), so this just keeps the JS UI in
      // sync with what the native side is about to report.
      p.setIsAutoPaused(false);
      p.setSignalLost(false);
      p.setMovingMs(0);

      await GpsRecorder.start();
      // U18: update recordingStateRef SYNCHRONOUSLY before setRecordingState
      // so the 'gnss' event handler (which reads the ref) sees 'recording'
      // immediately. Otherwise the ref would lag behind state by one render
      // and a 'gnss' event arriving in that window could override
      // currentSpeed despite us just having started recording.
      p.recordingStateRef.current = 'recording';
      p.setRecordingState('recording');
      p.syncStateFromNative();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      p.setErrorMsg(msg);
      p.recordingStateRef.current = 'idle';
      p.setRecordingState('idle');
    }
  })();
}

// ---------------------------------------------------------------------------
// handleStop
// ---------------------------------------------------------------------------

export type HandleStopParams = {
  setErrorMsg: (msg: string | null) => void;
  setRecordingState: React.Dispatch<React.SetStateAction<RecordingState>>;
  recordingStateRef: React.MutableRefObject<RecordingState>;
  stopTimeoutRef: React.MutableRefObject<number | null>;
  // H4 fix (Task 3): hard grace-period fallback ref. Same lifecycle as
  // stopTimeoutRef — scheduled in stopRecording, cancelled by the 'saved'
  // event handler. Fires after STOP_HARD_FALLBACK_MS to forcibly recover
  // the UI to 'idle' if the normal 'saved' / 1 s syncStateFromNative paths
  // failed to do so.
  stopHardTimeoutRef: React.MutableRefObject<number | null>;
  syncStateFromNative: () => Promise<void>;
};

// H4 fix (Task 3): hard grace-period for the "stopping" overlay. If neither
// the 'saved' event nor the 1 s syncStateFromNative() poll has recovered
// the UI to 'idle' within this many milliseconds, forcibly reset to 'idle'.
//
// 15 s is chosen as a balance:
//   - Long enough that a normal GPX finalize (Gaussian smoothing + Douglas-
//     Peucker on a multi-hour track) completes well within it, especially
//     after Task 4 moves that work off the main thread.
//   - Short enough that the user doesn't feel the app is hung if the stop
//     intent was genuinely lost (e.g. the OS killed the service mid-stop).
//
// When this fires, the saved card will NOT be shown (no 'saved' event
// arrived) but the user is at least able to press START again. The GPX
// file (if it was written) is still in Downloads/trck/.
const STOP_HARD_FALLBACK_MS = 15_000;

export function stopRecording(p: HandleStopParams) {
  return (async () => {
    p.setErrorMsg(null);
    // U18: update recordingStateRef SYNCHRONOUSLY before setRecordingState.
    p.recordingStateRef.current = 'stopping';
    p.setRecordingState('stopping');
    try {
      await GpsRecorder.stop();
      // U16: track the timeout so the 'saved' event handler can cancel it.
      // Without this, a delayed syncStateFromNative() can fire AFTER the
      // 'saved' event has already transitioned the UI to 'idle' + shown
      // the saved card — causing a brief flicker back to 'stopping'.
      p.stopTimeoutRef.current = setTimeout(() => {
        p.stopTimeoutRef.current = null;
        p.syncStateFromNative();
      }, 1000) as unknown as number;

      // H4 fix (Task 3): schedule the hard grace-period fallback. If the
      // UI is STILL in 'stopping' after STOP_HARD_FALLBACK_MS, forcibly
      // reset to 'idle'. This handles the case where the stop intent was
      // lost (the native service is hung or unresponsive and keeps
      // reporting isRecording=true), which would otherwise leave the
      // "Сохранение GPX…" overlay on screen forever.
      //
      // The 'saved' event handler cancels this timer (see
      // createSavedHandler). The 1 s syncStateFromNative above does NOT
      // cancel it — even if the 1 s poll recovers the UI to 'idle',
      // leaving the hard timer pending is harmless (it'll just no-op
      // because recordingStateRef.current will already be 'idle').
      p.stopHardTimeoutRef.current = setTimeout(() => {
        p.stopHardTimeoutRef.current = null;
        if (p.recordingStateRef.current === 'stopping') {
          // State correction: forcibly recover to 'idle' so the user can
          // press START again. Don't clear errorMsg here — if the stop
          // truly failed silently, the user should still see any prior
          // error message.
          p.recordingStateRef.current = 'idle';
          p.setRecordingState('idle');
        }
      }, STOP_HARD_FALLBACK_MS) as unknown as number;
    } catch (e: unknown) {
      p.setErrorMsg(e instanceof Error ? e.message : String(e));
      // Revert to 'recording' so the user can try STOP again.
      p.recordingStateRef.current = 'recording';
      p.setRecordingState('recording');
      // H4 fix: if stop() itself threw, cancel any pending hard fallback
      // — we've already reverted to 'recording' above.
      if (p.stopHardTimeoutRef.current != null) {
        clearTimeout(p.stopHardTimeoutRef.current);
        p.stopHardTimeoutRef.current = null;
      }
    }
  })();
}
