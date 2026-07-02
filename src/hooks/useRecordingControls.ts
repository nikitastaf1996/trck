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
  syncStateFromNative: () => Promise<void>;
};

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
    } catch (e: unknown) {
      p.setErrorMsg(e instanceof Error ? e.message : String(e));
      // Revert to 'recording' so the user can try STOP again.
      p.recordingStateRef.current = 'recording';
      p.setRecordingState('recording');
    }
  })();
}
