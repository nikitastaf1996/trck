/**
 * Tests for useRecordingControls — the pure factory functions for
 * handleStart and handleStop.
 *
 * These factories are pure functions (no React imports beyond the
 * type-only MutableRefObject import), so we can test them directly.
 *
 * Coverage:
 *
 *   startRecording:
 *     - When hasPermissions=true: skips requestPermissions + shows no overlay.
 *     - Resets all the recording state (elapsed, distance, speed, save card).
 *     - Calls GpsRecorder.start() and transitions to 'recording'.
 *     - Updates recordingStateRef SYNCHRONOUSLY before setRecordingState (U18).
 *     - When hasPermissions=false + cancelPermissionWaitRef.current=true: bails out.
 *     - When hasPermissions=false + requestPermissions returns false: shows error.
 *     - When GpsRecorder.start() throws: reverts to 'idle' + sets error.
 *
 *   stopRecording:
 *     - Transitions to 'stopping' + updates ref synchronously.
 *     - Calls GpsRecorder.stop().
 *     - Schedules the 1s fallback syncStateFromNative().
 *     - Schedules the 15s hard fallback that forcibly resets to 'idle'.
 *     - When GpsRecorder.stop() throws: reverts to 'recording' + sets error.
 */
import { startRecording, stopRecording } from '../../src/hooks/useRecordingControls';
import type { RecordingState } from '../../src/styles';
import { gpsMock, clearGpsMock, makeRef } from '../helpers';
import { NativeModules } from 'react-native';

beforeEach(() => {
  clearGpsMock();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// startRecording
// ---------------------------------------------------------------------------

describe('startRecording', () => {
  function setup() {
    return {
      setErrorMsg: jest.fn(),
      setRecordingState: jest.fn(),
      setElapsedMs: jest.fn(),
      setDistance: jest.fn(),
      setCurrentSpeed: jest.fn(),
      setLastSavedPath: jest.fn(),
      setLastSavedSettings: jest.fn(),
      setWaitingForPermissions: jest.fn(),
      setHasPermissions: jest.fn(),
      setBatteryOptDenied: jest.fn(),
      cancelPermissionWaitRef: makeRef<boolean>(false),
      hasAskedBatteryOptRef: makeRef<boolean>(false),
      recordingStateRef: makeRef<RecordingState>('idle'),
      recentSpeedsRef: makeRef<number[]>([1, 2, 3]),
      startMonitor: jest.fn().mockResolvedValue(true),
      syncStateFromNative: jest.fn().mockResolvedValue(undefined),
      setIsAutoPaused: jest.fn(),
      setSignalLost: jest.fn(),
      setMovingMs: jest.fn(),
    };
  }

  it('skips requestPermissions when hasPermissions() returns true', async () => {
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValueOnce(true);
    const p = setup();
    await startRecording(p);
    expect(NativeModules.GpsRecorder!.requestPermissions).not.toHaveBeenCalled();
    expect(p.setWaitingForPermissions).not.toHaveBeenCalledWith(true);
  });

  it('calls requestPermissions + shows overlay when hasPermissions() returns false', async () => {
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValueOnce(false);
    (gpsMock.requestPermissions as jest.Mock).mockResolvedValueOnce(true);
    const p = setup();
    await startRecording(p);
    expect(p.setWaitingForPermissions).toHaveBeenCalledWith(true);
    expect(p.setWaitingForPermissions).toHaveBeenCalledWith(false);
    expect(NativeModules.GpsRecorder!.requestPermissions).toHaveBeenCalledTimes(1);
  });

  it('shows the battery-opt dialog once per session (hasAskedBatteryOptRef gate)', async () => {
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValue(true);
    const p = setup();
    await startRecording(p);
    expect(NativeModules.GpsRecorder!.requestIgnoreBatteryOptimizations).toHaveBeenCalledTimes(1);
    expect(p.hasAskedBatteryOptRef.current).toBe(true);
  });

  it('does NOT show the battery-opt dialog twice in the same session', async () => {
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValue(true);
    const p = setup();
    p.hasAskedBatteryOptRef.current = true; // already asked
    await startRecording(p);
    expect(NativeModules.GpsRecorder!.requestIgnoreBatteryOptimizations).not.toHaveBeenCalled();
  });

  it('clears all the recording state (elapsed / distance / speed / save card)', async () => {
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValue(true);
    const p = setup();
    await startRecording(p);
    expect(p.setElapsedMs).toHaveBeenCalledWith(0);
    expect(p.setDistance).toHaveBeenCalledWith(0);
    expect(p.setCurrentSpeed).toHaveBeenCalledWith(null);
    expect(p.setLastSavedPath).toHaveBeenCalledWith(null);
    expect(p.setLastSavedSettings).toHaveBeenCalledWith(null);
    expect(p.recentSpeedsRef.current).toEqual([]);
  });

  it('clears the stale auto-pause / signal-lost / moving-time flags (Task 9)', async () => {
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValue(true);
    const p = setup();
    await startRecording(p);
    expect(p.setIsAutoPaused).toHaveBeenCalledWith(false);
    expect(p.setSignalLost).toHaveBeenCalledWith(false);
    expect(p.setMovingMs).toHaveBeenCalledWith(0);
  });

  it('calls GpsRecorder.start() and transitions to "recording"', async () => {
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValue(true);
    const p = setup();
    await startRecording(p);
    expect(NativeModules.GpsRecorder!.start).toHaveBeenCalledTimes(1);
    expect(p.setRecordingState).toHaveBeenCalledWith('recording');
  });

  it('updates recordingStateRef SYNCHRONOUSLY before setRecordingState (U18)', async () => {
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValue(true);
    const p = setup();
    // Track the order: ref.current = 'recording' should happen BEFORE
    // setRecordingState is called with 'recording'.
    const order: string[] = [];
    p.setRecordingState.mockImplementation(() => {
      order.push(`setRecordingState(ref=${p.recordingStateRef.current})`);
    });
    await startRecording(p);
    // The ref should already be 'recording' when setRecordingState was called.
    expect(order).toContain('setRecordingState(ref=recording)');
  });

  it('bails out silently when cancelPermissionWaitRef.current=true (user pressed Отмена)', async () => {
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValueOnce(false);
    (gpsMock.requestPermissions as jest.Mock).mockResolvedValueOnce(false);
    const p = setup();
    p.cancelPermissionWaitRef.current = true; // simulate cancel
    await startRecording(p);
    // Should NOT have started recording.
    expect(NativeModules.GpsRecorder!.start).not.toHaveBeenCalled();
    expect(p.setRecordingState).not.toHaveBeenCalledWith('recording');
  });

  it('sets an error message and reverts to "idle" when hasPermissions=false + requestPermissions returns false', async () => {
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValueOnce(false);
    (gpsMock.requestPermissions as jest.Mock).mockResolvedValueOnce(false);
    const p = setup();
    await startRecording(p);
    expect(p.setErrorMsg).toHaveBeenCalled();
    expect(p.setRecordingState).not.toHaveBeenCalledWith('recording');
    expect(NativeModules.GpsRecorder!.start).not.toHaveBeenCalled();
  });

  it('reverts to "idle" + sets error when GpsRecorder.start() throws', async () => {
    (gpsMock.hasPermissions as jest.Mock).mockResolvedValue(true);
    (gpsMock.start as jest.Mock).mockRejectedValueOnce(new Error('start failed'));
    const p = setup();
    await startRecording(p);
    expect(p.setErrorMsg).toHaveBeenCalledWith('start failed');
    expect(p.recordingStateRef.current).toBe('idle');
    expect(p.setRecordingState).toHaveBeenCalledWith('idle');
  });
});

// ---------------------------------------------------------------------------
// stopRecording
// ---------------------------------------------------------------------------

describe('stopRecording', () => {
  function setup() {
    return {
      setErrorMsg: jest.fn(),
      setRecordingState: jest.fn(),
      recordingStateRef: makeRef<RecordingState>('recording'),
      stopTimeoutRef: makeRef<number | null>(null),
      stopHardTimeoutRef: makeRef<number | null>(null),
      syncStateFromNative: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('transitions to "stopping" + updates ref synchronously (U18)', async () => {
    const p = setup();
    const order: string[] = [];
    p.setRecordingState.mockImplementation(() => {
      order.push(`setRecordingState(ref=${p.recordingStateRef.current})`);
    });
    await stopRecording(p);
    expect(p.recordingStateRef.current).toBe('stopping');
    expect(p.setRecordingState).toHaveBeenCalledWith('stopping');
    expect(order).toContain('setRecordingState(ref=stopping)');
  });

  it('calls GpsRecorder.stop()', async () => {
    const p = setup();
    await stopRecording(p);
    expect(NativeModules.GpsRecorder!.stop).toHaveBeenCalledTimes(1);
  });

  it('schedules the 1s fallback syncStateFromNative (U16)', async () => {
    const p = setup();
    await stopRecording(p);
    expect(p.stopTimeoutRef.current).not.toBeNull();
    // Advance 1 second — the timeout should fire.
    jest.advanceTimersByTime(1000);
    expect(p.syncStateFromNative).toHaveBeenCalledTimes(1);
    // The ref should be cleared after firing.
    expect(p.stopTimeoutRef.current).toBeNull();
  });

  it('schedules the 15s hard fallback that forcibly resets to "idle" (H4)', async () => {
    const p = setup();
    await stopRecording(p);
    expect(p.stopHardTimeoutRef.current).not.toBeNull();
    // Advance 15 seconds — the hard fallback should fire and forcibly
    // reset to 'idle' since recordingStateRef is still 'stopping'.
    jest.advanceTimersByTime(15_000);
    expect(p.recordingStateRef.current).toBe('idle');
    expect(p.setRecordingState).toHaveBeenCalledWith('idle');
    expect(p.stopHardTimeoutRef.current).toBeNull();
  });

  it('the hard fallback does NOT fire if recordingStateRef has already transitioned away from "stopping"', async () => {
    const p = setup();
    await stopRecording(p);
    // Simulate a successful 'saved' event arriving before the 15s timer.
    p.recordingStateRef.current = 'idle';
    p.setRecordingState.mockClear();
    jest.advanceTimersByTime(15_000);
    // The hard fallback saw recordingStateRef !== 'stopping' → no-op.
    expect(p.setRecordingState).not.toHaveBeenCalled();
  });

  it('reverts to "recording" + sets error when GpsRecorder.stop() throws', async () => {
    (gpsMock.stop as jest.Mock).mockRejectedValueOnce(new Error('stop failed'));
    const p = setup();
    await stopRecording(p);
    expect(p.setErrorMsg).toHaveBeenCalledWith('stop failed');
    expect(p.recordingStateRef.current).toBe('recording');
    expect(p.setRecordingState).toHaveBeenCalledWith('recording');
    // The hard fallback timer should have been cancelled.
    expect(p.stopHardTimeoutRef.current).toBeNull();
  });

  it('clears the error message at the start of stopRecording', async () => {
    const p = setup();
    await stopRecording(p);
    expect(p.setErrorMsg).toHaveBeenCalledWith(null);
  });
});
