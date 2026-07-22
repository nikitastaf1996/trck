/**
 * Tests for the recording Zustand store (src/store/recordingStore.ts).
 *
 * These tests replace the previous hook tests (useRecordingSession,
 * useRecordingEventHandlers, useRecordingControls, useGnssMonitor,
 * usePermissions). The store is exercised directly via
 * `useRecordingStore.getState()` and `setState()` — no React render
 * needed.
 */

import { useRecordingStore, SPEED_WINDOW, subscribeAllNativeEvents } from '../../src/store/recordingStore';
import { useSettingsStore } from '../../src/store/settingsStore';
import { gpsMock, clearGpsMock, resetStores } from '../helpers';
import { DeviceEventEmitter } from 'react-native';

describe('recordingStore — initial state', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('starts in the idle state with zeroed telemetry', () => {
    const s = useRecordingStore.getState();
    expect(s.recordingState).toBe('idle');
    expect(s.elapsedMs).toBe(0);
    expect(s.distance).toBe(0);
    expect(s.currentSpeed).toBeNull();
    expect(s.isAutoPaused).toBe(false);
    expect(s.signalLost).toBe(false);
    expect(s.movingMs).toBe(0);
    expect(s.recentSpeeds).toEqual([]);
  });

  it('starts with no fix and no satellites', () => {
    const s = useRecordingStore.getState();
    expect(s.fixType).toBe('no fix');
    expect(s.hasFix).toBe(false);
    expect(s.accuracy).toBeNull();
    expect(s.satellitesUsed).toBe(0);
    expect(s.satellitesInView).toBe(0);
  });

  it('starts with no saved card and no error', () => {
    const s = useRecordingStore.getState();
    expect(s.lastSavedPath).toBeNull();
    expect(s.lastSavedDistance).toBeNull();
    expect(s.lastSavedMovingMs).toBe(0);
    expect(s.lastSavedElapsedMs).toBe(0);
    expect(s.lastSavedSettings).toBeNull();
    expect(s.errorMsg).toBeNull();
  });
});

describe('recordingStore — applyLocationEvent', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('updates distance, fixType, accuracy from a location event', () => {
    useRecordingStore.getState().applyLocationEvent({
      lat: 55.75, lon: 37.62, alt: 100, speed: 1.5, accuracy: 5,
      fixType: '3D fix', distance: 1234.5, timestamp: Date.now(),
      pointCount: 42, isAutoPaused: false, signalLost: false, movingMs: 60000,
    });
    const s = useRecordingStore.getState();
    expect(s.distance).toBe(1234.5);
    expect(s.fixType).toBe('3D fix');
    expect(s.accuracy).toBe(5);
    expect(s.hasFix).toBe(true);
    expect(s.currentSpeed).toBe(1.5);
  });

  it('pushes the speed into the smoothing window when not auto-paused', () => {
    useRecordingStore.getState().applyLocationEvent({
      lat: 0, lon: 0, alt: null, speed: 2.0, accuracy: 5,
      fixType: '3D fix', distance: 0, timestamp: 0,
      pointCount: 0, isAutoPaused: false, signalLost: false, movingMs: 0,
    });
    useRecordingStore.getState().applyLocationEvent({
      lat: 0, lon: 0, alt: null, speed: 3.0, accuracy: 5,
      fixType: '3D fix', distance: 0, timestamp: 0,
      pointCount: 0, isAutoPaused: false, signalLost: false, movingMs: 0,
    });
    expect(useRecordingStore.getState().recentSpeeds).toEqual([2.0, 3.0]);
  });

  it('does NOT push speed into the window while auto-paused (U10)', () => {
    useRecordingStore.setState({ isAutoPaused: true });
    useRecordingStore.getState().applyLocationEvent({
      lat: 0, lon: 0, alt: null, speed: 2.0, accuracy: 5,
      fixType: '3D fix', distance: 0, timestamp: 0,
      pointCount: 0, isAutoPaused: true, signalLost: false, movingMs: 0,
    });
    expect(useRecordingStore.getState().recentSpeeds).toEqual([]);
    expect(useRecordingStore.getState().currentSpeed).toBeNull();
  });

  it('caps the smoothing window at SPEED_WINDOW entries', () => {
    for (let i = 0; i < SPEED_WINDOW + 3; i++) {
      useRecordingStore.getState().applyLocationEvent({
        lat: 0, lon: 0, alt: null, speed: i, accuracy: 5,
        fixType: '3D fix', distance: 0, timestamp: 0,
        pointCount: 0, isAutoPaused: false, signalLost: false, movingMs: 0,
      });
    }
    const w = useRecordingStore.getState().recentSpeeds;
    expect(w.length).toBe(SPEED_WINDOW);
    // The last SPEED_WINDOW entries (indices SPEED_WINDOW+3-5 .. SPEED_WINDOW+3-1)
    expect(w).toEqual([SPEED_WINDOW + 3 - 5, SPEED_WINDOW + 3 - 4, SPEED_WINDOW + 3 - 3, SPEED_WINDOW + 3 - 2, SPEED_WINDOW + 3 - 1]);
  });
});

describe('recordingStore — applyDurationEvent (L24 out-of-order drop)', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('updates elapsedMs from a duration event', () => {
    useRecordingStore.getState().applyDurationEvent({ elapsedMs: 5000, movingMs: 4000, seq: 1 });
    expect(useRecordingStore.getState().elapsedMs).toBe(5000);
    expect(useRecordingStore.getState().movingMs).toBe(4000);
  });

  it('drops duration events with seq <= lastDurationSeq (L24)', () => {
    useRecordingStore.getState().applyDurationEvent({ elapsedMs: 5000, movingMs: 4000, seq: 5 });
    useRecordingStore.getState().applyDurationEvent({ elapsedMs: 4000, movingMs: 3000, seq: 3 });
    expect(useRecordingStore.getState().elapsedMs).toBe(5000); // not overwritten
  });

  it('accepts duration events with a higher seq', () => {
    useRecordingStore.getState().applyDurationEvent({ elapsedMs: 5000, movingMs: 4000, seq: 5 });
    useRecordingStore.getState().applyDurationEvent({ elapsedMs: 6000, movingMs: 5000, seq: 6 });
    expect(useRecordingStore.getState().elapsedMs).toBe(6000);
  });

  it('handles events without a seq (legacy native modules)', () => {
    useRecordingStore.getState().applyDurationEvent({ elapsedMs: 5000 });
    expect(useRecordingStore.getState().elapsedMs).toBe(5000);
  });
});

describe('recordingStore — applyStateEvent', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('transitions to recording and syncs telemetry when isRecording=true', () => {
    useRecordingStore.getState().applyStateEvent({
      isRecording: true, pointCount: 10, elapsedMs: 30000,
      isAutoPaused: false, signalLost: false, movingMs: 25000,
    });
    const s = useRecordingStore.getState();
    expect(s.recordingState).toBe('recording');
    expect(s.elapsedMs).toBe(30000);
    expect(s.movingMs).toBe(25000);
  });

  it('transitions to idle and resets telemetry when isRecording=false', () => {
    useRecordingStore.setState({
      recordingState: 'recording', elapsedMs: 30000, distance: 1000,
      isAutoPaused: true, signalLost: true, movingMs: 25000,
      recentSpeeds: [1, 2, 3], fixType: '3D fix', hasFix: true, accuracy: 5,
    });
    useRecordingStore.getState().applyStateEvent({
      isRecording: false, pointCount: 0, elapsedMs: 0,
      isAutoPaused: false, signalLost: false, movingMs: 0,
    });
    const s = useRecordingStore.getState();
    expect(s.recordingState).toBe('idle');
    expect(s.elapsedMs).toBe(0);
    expect(s.distance).toBe(0);
    expect(s.isAutoPaused).toBe(false);
    expect(s.signalLost).toBe(false);
    expect(s.movingMs).toBe(0);
    expect(s.recentSpeeds).toEqual([]);
    expect(s.fixType).toBe('no fix');
    expect(s.hasFix).toBe(false);
  });
});

describe('recordingStore — applySavedEvent', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('snapshots movingMs/elapsedMs/settings before resetting (U3 / Task 4)', () => {
    useRecordingStore.setState({
      recordingState: 'stopping', elapsedMs: 60000, movingMs: 50000,
    });
    useSettingsStore.setState({
      autoPauseEnabled: true, gapDetectionEnabled: false, showMovingTime: true,
    });
    useRecordingStore.getState().applySavedEvent({
      filePath: '/path/to/file.gpx', pointCount: 100, finalDistanceM: 4321,
    });
    const s = useRecordingStore.getState();
    expect(s.lastSavedPath).toBe('/path/to/file.gpx');
    expect(s.lastSavedDistance).toBe(4321);
    expect(s.lastSavedMovingMs).toBe(50000);
    expect(s.lastSavedElapsedMs).toBe(60000);
    expect(s.lastSavedSettings).toEqual({
      autoPauseEnabled: true, gapDetectionEnabled: false, showMovingTime: true,
    });
  });

  it('resets to idle after save', () => {
    useRecordingStore.setState({ recordingState: 'stopping', elapsedMs: 60000 });
    useRecordingStore.getState().applySavedEvent({
      filePath: '/x.gpx', pointCount: 1,
    });
    const s = useRecordingStore.getState();
    expect(s.recordingState).toBe('idle');
    expect(s.elapsedMs).toBe(0);
  });

  it('cancels pending stop fallback timers', () => {
    const t = setTimeout(() => { /* noop */ }, 1000);
    const ht = setTimeout(() => { /* noop */ }, 15000);
    useRecordingStore.setState({
      _stopFallbackTimer: t, _stopHardFallbackTimer: ht,
    });
    useRecordingStore.getState().applySavedEvent({ filePath: '/x.gpx', pointCount: 1 });
    expect(useRecordingStore.getState()._stopFallbackTimer).toBeNull();
    expect(useRecordingStore.getState()._stopHardFallbackTimer).toBeNull();
    clearTimeout(t);
    clearTimeout(ht);
  });

  it('treats negative finalDistanceM as "not available"', () => {
    useRecordingStore.getState().applySavedEvent({
      filePath: '/x.gpx', pointCount: 1, finalDistanceM: -1,
    });
    expect(useRecordingStore.getState().lastSavedDistance).toBeNull();
  });
});

describe('recordingStore — applyErrorEvent', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('resets to idle on a FATAL error (L10 / U17)', () => {
    useRecordingStore.setState({ recordingState: 'recording' });
    useRecordingStore.getState().applyErrorEvent({ message: 'boom', fatal: true });
    expect(useRecordingStore.getState().recordingState).toBe('idle');
    expect(useRecordingStore.getState().errorMsg).toBe('boom');
  });

  it('does NOT reset to idle on a NON-FATAL error (L10 / U17)', () => {
    useRecordingStore.setState({ recordingState: 'recording' });
    useRecordingStore.getState().applyErrorEvent({ message: 'recompute failed', fatal: false });
    expect(useRecordingStore.getState().recordingState).toBe('recording');
    expect(useRecordingStore.getState().errorMsg).toBe('recompute failed');
  });
});

describe('recordingStore — applyGnssEvent', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('updates all 5 GNSS status fields together', () => {
    useRecordingStore.getState().applyGnssEvent({
      fixType: '3D fix', accuracy: 8, satellitesUsed: 12, satellitesInView: 24,
      hasFix: true, lat: 55, lon: 37, alt: 100, speed: 1.5, timestamp: 0,
    });
    const s = useRecordingStore.getState();
    expect(s.fixType).toBe('3D fix');
    expect(s.accuracy).toBe(8);
    expect(s.satellitesUsed).toBe(12);
    expect(s.satellitesInView).toBe(24);
    expect(s.hasFix).toBe(true);
  });
});

describe('recordingStore — syncFromNative', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('syncs to recording when native reports isRecording=true', () => {
    useRecordingStore.getState().syncFromNative({
      isRecording: true, pointCount: 5, elapsedMs: 10000, distance: 200,
      fixType: '3D fix', lastFix: null, isAutoPaused: false, signalLost: false, movingMs: 9000,
    });
    const s = useRecordingStore.getState();
    expect(s.recordingState).toBe('recording');
    expect(s.distance).toBe(200);
    expect(s.movingMs).toBe(9000);
  });

  it('preserves "stopping" state if native reports isRecording=true but UI is stopping (H4 fix)', () => {
    useRecordingStore.setState({ recordingState: 'stopping', elapsedMs: 10000 });
    useRecordingStore.getState().syncFromNative({
      isRecording: true, pointCount: 5, elapsedMs: 10000, distance: 200,
      fixType: '3D fix', lastFix: null, isAutoPaused: false, signalLost: false, movingMs: 9000,
    });
    expect(useRecordingStore.getState().recordingState).toBe('stopping');
  });

  it('recovers from "stopping" to "idle" when native reports isRecording=false (H4 fix)', () => {
    useRecordingStore.setState({ recordingState: 'stopping' });
    useRecordingStore.getState().syncFromNative({
      isRecording: false, pointCount: 0, elapsedMs: 0, distance: 0,
      fixType: 'no fix', lastFix: null, isAutoPaused: false, signalLost: false, movingMs: 0,
    });
    expect(useRecordingStore.getState().recordingState).toBe('idle');
  });

  it('does NOT overwrite elapsedMs with a stale (smaller) poll value (L24)', () => {
    useRecordingStore.setState({ elapsedMs: 30000 });
    useRecordingStore.getState().syncFromNative({
      isRecording: true, pointCount: 0, elapsedMs: 25000, distance: 0,
      fixType: '3D fix', lastFix: null, isAutoPaused: false, signalLost: false, movingMs: 0,
    });
    expect(useRecordingStore.getState().elapsedMs).toBe(30000); // not overwritten
  });
});

describe('recordingStore — pushIdleSpeed (U4)', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('pushes a speed into the window and updates currentSpeed', () => {
    useRecordingStore.getState().pushIdleSpeed(2.5);
    expect(useRecordingStore.getState().currentSpeed).toBe(2.5);
    expect(useRecordingStore.getState().recentSpeeds).toEqual([2.5]);
  });

  it('clears currentSpeed when given null', () => {
    useRecordingStore.setState({ currentSpeed: 1.5, recentSpeeds: [1.5] });
    useRecordingStore.getState().pushIdleSpeed(null);
    expect(useRecordingStore.getState().currentSpeed).toBeNull();
    expect(useRecordingStore.getState().recentSpeeds).toEqual([1.5]); // unchanged
  });

  it('caps the window at SPEED_WINDOW entries', () => {
    for (let i = 0; i < SPEED_WINDOW + 2; i++) {
      useRecordingStore.getState().pushIdleSpeed(i);
    }
    expect(useRecordingStore.getState().recentSpeeds.length).toBe(SPEED_WINDOW);
  });
});

describe('recordingStore — handleStart', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('returns granted:true and transitions to recording when permissions already granted', async () => {
    gpsMock.hasPermissions.mockResolvedValue(true);
    gpsMock.requestIgnoreBatteryOptimizations.mockResolvedValue(true);
    gpsMock.start.mockResolvedValue(undefined);
    const { granted } = await useRecordingStore.getState().handleStart();
    expect(granted).toBe(true);
    expect(useRecordingStore.getState().recordingState).toBe('recording');
    expect(gpsMock.start).toHaveBeenCalledTimes(1);
  });

  it('shows the permission-wait overlay then requests permissions when not granted', async () => {
    gpsMock.hasPermissions.mockResolvedValueOnce(false); // initial check
    gpsMock.requestPermissions.mockResolvedValue(true);
    gpsMock.hasPermissions.mockResolvedValueOnce(true); // post-request check (not used by handleStart, but for safety)
    gpsMock.requestIgnoreBatteryOptimizations.mockResolvedValue(true);
    gpsMock.start.mockResolvedValue(undefined);
    const { granted } = await useRecordingStore.getState().handleStart();
    expect(granted).toBe(true);
    expect(gpsMock.requestPermissions).toHaveBeenCalledTimes(1);
  });

  it('returns granted:false without starting when permissions denied', async () => {
    gpsMock.hasPermissions.mockResolvedValueOnce(false); // initial check
    gpsMock.requestPermissions.mockResolvedValue(false);
    const { granted } = await useRecordingStore.getState().handleStart();
    expect(granted).toBe(false);
    expect(useRecordingStore.getState().recordingState).toBe('idle');
    expect(gpsMock.start).not.toHaveBeenCalled();
    expect(useRecordingStore.getState().errorMsg).not.toBeNull();
  });

  it('bails out silently when the user cancels the permission-wait overlay', async () => {
    gpsMock.hasPermissions.mockResolvedValueOnce(false);
    gpsMock.requestPermissions.mockImplementation(() => {
      // Simulate the user pressing Cancel while the dialog is up.
      useRecordingStore.getState().handleCancelPermissionWait();
      return Promise.resolve(true);
    });
    const { granted } = await useRecordingStore.getState().handleStart();
    expect(granted).toBe(false);
    expect(gpsMock.start).not.toHaveBeenCalled();
  });

  it('only shows the battery-opt dialog ONCE per session (U12)', async () => {
    gpsMock.hasPermissions.mockResolvedValue(true);
    gpsMock.requestIgnoreBatteryOptimizations.mockResolvedValue(true);
    gpsMock.start.mockResolvedValue(undefined);
    await useRecordingStore.getState().handleStart();
    expect(gpsMock.requestIgnoreBatteryOptimizations).toHaveBeenCalledTimes(1);
    await useRecordingStore.getState().handleStop();
    await useRecordingStore.getState().handleStart();
    // Should NOT have been called a second time.
    expect(gpsMock.requestIgnoreBatteryOptimizations).toHaveBeenCalledTimes(1);
  });

  it('clears all live telemetry for a fresh recording', async () => {
    useRecordingStore.setState({
      elapsedMs: 9999, distance: 9999, currentSpeed: 9,
      isAutoPaused: true, signalLost: true, movingMs: 9999,
      recentSpeeds: [9, 9, 9], lastSavedPath: '/old.gpx',
    });
    gpsMock.hasPermissions.mockResolvedValue(true);
    gpsMock.requestIgnoreBatteryOptimizations.mockResolvedValue(true);
    gpsMock.start.mockResolvedValue(undefined);
    await useRecordingStore.getState().handleStart();
    const s = useRecordingStore.getState();
    expect(s.elapsedMs).toBe(0);
    expect(s.distance).toBe(0);
    expect(s.currentSpeed).toBeNull();
    expect(s.isAutoPaused).toBe(false);
    expect(s.signalLost).toBe(false);
    expect(s.movingMs).toBe(0);
    expect(s.recentSpeeds).toEqual([]);
    expect(s.lastSavedPath).toBeNull();
  });
});

describe('recordingStore — handleStop (U16, H4)', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  afterEach(() => {
    // Clear any lingering real timers from handleStop so they don't
    // leak into the next test (the 'saved' event would normally cancel
    // them, but in tests we don't always fire one).
    const s = useRecordingStore.getState();
    if (s._stopFallbackTimer) clearTimeout(s._stopFallbackTimer);
    if (s._stopHardFallbackTimer) clearTimeout(s._stopHardFallbackTimer);
  });

  it('transitions to stopping and calls GpsRecorder.stop()', async () => {
    gpsMock.stop.mockResolvedValue(undefined);
    await useRecordingStore.getState().handleStop();
    expect(useRecordingStore.getState().recordingState).toBe('stopping');
    expect(gpsMock.stop).toHaveBeenCalledTimes(1);
  });

  it('schedules both the 1 s soft fallback and the 15 s hard fallback', async () => {
    gpsMock.stop.mockResolvedValue(undefined);
    await useRecordingStore.getState().handleStop();
    expect(useRecordingStore.getState()._stopFallbackTimer).not.toBeNull();
    expect(useRecordingStore.getState()._stopHardFallbackTimer).not.toBeNull();
  });

  it('applySavedEvent cancels both timers (U16, H4)', async () => {
    gpsMock.stop.mockResolvedValue(undefined);
    await useRecordingStore.getState().handleStop();
    expect(useRecordingStore.getState()._stopFallbackTimer).not.toBeNull();
    expect(useRecordingStore.getState()._stopHardFallbackTimer).not.toBeNull();
    useRecordingStore.getState().applySavedEvent({ filePath: '/x.gpx', pointCount: 1 });
    expect(useRecordingStore.getState()._stopFallbackTimer).toBeNull();
    expect(useRecordingStore.getState()._stopHardFallbackTimer).toBeNull();
  });

  it('reverts to recording if stop() throws', async () => {
    useRecordingStore.setState({ recordingState: 'recording' });
    gpsMock.stop.mockRejectedValue(new Error('stop failed'));
    await useRecordingStore.getState().handleStop();
    expect(useRecordingStore.getState().recordingState).toBe('recording');
    expect(useRecordingStore.getState().errorMsg).toBe('stop failed');
  });
});

describe('recordingStore — permission / battery handlers', () => {
  beforeEach(() => {
    resetStores();
    clearGpsMock();
  });

  it('initialPermissionCheck returns true when permissions already granted', async () => {
    gpsMock.hasPermissions.mockResolvedValue(true);
    const granted = await useRecordingStore.getState().initialPermissionCheck();
    expect(granted).toBe(true);
    expect(useRecordingStore.getState().hasPermissions).toBe(true);
  });

  it('initialPermissionCheck requests and waits when not granted', async () => {
    gpsMock.hasPermissions.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    gpsMock.requestPermissions.mockResolvedValue(true);
    jest.useFakeTimers();
    try {
      const p = useRecordingStore.getState().initialPermissionCheck();
      await jest.advanceTimersByTimeAsync(900);
      const granted = await p;
      expect(granted).toBe(true);
      expect(gpsMock.requestPermissions).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('handleRetryBatteryOpt sets batteryOptDenied=false when granted', async () => {
    gpsMock.requestIgnoreBatteryOptimizations.mockResolvedValue(true);
    await useRecordingStore.getState().handleRetryBatteryOpt();
    expect(useRecordingStore.getState().batteryOptDenied).toBe(false);
  });

  it('handleRetryBatteryOpt sets batteryOptDenied=true when denied', async () => {
    gpsMock.requestIgnoreBatteryOptimizations.mockResolvedValue(false);
    await useRecordingStore.getState().handleRetryBatteryOpt();
    expect(useRecordingStore.getState().batteryOptDenied).toBe(true);
  });

  it('handleCancelPermissionWait clears the overlay and sets the cancel flag', () => {
    useRecordingStore.setState({ waitingForPermissions: true });
    useRecordingStore.getState().handleCancelPermissionWait();
    expect(useRecordingStore.getState().waitingForPermissions).toBe(false);
    expect(useRecordingStore.getState().cancelPermissionWait).toBe(true);
  });
});

describe('recordingStore — UI dismiss actions', () => {
  beforeEach(() => {
    resetStores();
  });

  it('dismissSavedCard clears lastSavedPath', () => {
    useRecordingStore.setState({ lastSavedPath: '/x.gpx' });
    useRecordingStore.getState().dismissSavedCard();
    expect(useRecordingStore.getState().lastSavedPath).toBeNull();
  });

  it('dismissError clears errorMsg', () => {
    useRecordingStore.setState({ errorMsg: 'oops' });
    useRecordingStore.getState().dismissError();
    expect(useRecordingStore.getState().errorMsg).toBeNull();
  });

  it('setError sets errorMsg (used by settingsStore for revert-on-error)', () => {
    useRecordingStore.getState().setError('boom');
    expect(useRecordingStore.getState().errorMsg).toBe('boom');
  });
});

describe('recordingStore — subscribeAllNativeEvents', () => {
  let handle: ReturnType<typeof subscribeAllNativeEvents>;

  beforeEach(() => {
    resetStores();
    clearGpsMock();
    handle = subscribeAllNativeEvents();
  });

  afterEach(() => {
    if (handle) handle.remove();
  });

  it('dispatches a location event into the store', () => {
    DeviceEventEmitter.emit('location', {
      lat: 55, lon: 37, alt: 100, speed: 1.5, accuracy: 5,
      fixType: '3D fix', distance: 42, timestamp: 0,
      pointCount: 1, isAutoPaused: false, signalLost: false, movingMs: 0,
    });
    expect(useRecordingStore.getState().distance).toBe(42);
    expect(useRecordingStore.getState().fixType).toBe('3D fix');
  });

  it('dispatches a duration event into the store', () => {
    DeviceEventEmitter.emit('duration', { elapsedMs: 7000, movingMs: 6000, seq: 1 });
    expect(useRecordingStore.getState().elapsedMs).toBe(7000);
    expect(useRecordingStore.getState().movingMs).toBe(6000);
  });

  it('dispatches a state event into the store', () => {
    DeviceEventEmitter.emit('state', {
      isRecording: true, pointCount: 5, elapsedMs: 10000,
      isAutoPaused: false, signalLost: false, movingMs: 9000,
    });
    expect(useRecordingStore.getState().recordingState).toBe('recording');
  });

  it('dispatches a saved event into the store', () => {
    useRecordingStore.setState({ recordingState: 'stopping', elapsedMs: 5000, movingMs: 4000 });
    DeviceEventEmitter.emit('saved', { filePath: '/test.gpx', pointCount: 100, finalDistanceM: 1234 });
    expect(useRecordingStore.getState().lastSavedPath).toBe('/test.gpx');
    expect(useRecordingStore.getState().lastSavedDistance).toBe(1234);
    expect(useRecordingStore.getState().recordingState).toBe('idle');
  });

  it('dispatches an error event into the store (fatal resets to idle)', () => {
    useRecordingStore.setState({ recordingState: 'recording' });
    DeviceEventEmitter.emit('error', { message: 'boom', fatal: true });
    expect(useRecordingStore.getState().recordingState).toBe('idle');
    expect(useRecordingStore.getState().errorMsg).toBe('boom');
  });

  it('dispatches a gnss event into the store', () => {
    DeviceEventEmitter.emit('gnss', {
      fixType: '3D fix', accuracy: 8, satellitesUsed: 12, satellitesInView: 24,
      hasFix: true, lat: 55, lon: 37, alt: 100, speed: 1.5, timestamp: 0,
    });
    expect(useRecordingStore.getState().fixType).toBe('3D fix');
    expect(useRecordingStore.getState().satellitesUsed).toBe(12);
  });

  it('pushes gnss speed into the smoothing window when not recording (U4)', () => {
    // recordingState is 'idle' by default after resetStores
    DeviceEventEmitter.emit('gnss', {
      fixType: '3D fix', accuracy: 8, satellitesUsed: 12, satellitesInView: 24,
      hasFix: true, lat: 55, lon: 37, alt: 100, speed: 2.5, timestamp: 0,
    });
    expect(useRecordingStore.getState().currentSpeed).toBe(2.5);
    expect(useRecordingStore.getState().recentSpeeds).toEqual([2.5]);
  });

  it('does NOT push gnss speed when recording (location event is source of truth)', () => {
    useRecordingStore.setState({ recordingState: 'recording' });
    DeviceEventEmitter.emit('gnss', {
      fixType: '3D fix', accuracy: 8, satellitesUsed: 12, satellitesInView: 24,
      hasFix: true, lat: 55, lon: 37, alt: 100, speed: 2.5, timestamp: 0,
    });
    expect(useRecordingStore.getState().recentSpeeds).toEqual([]);
  });

  it('remove() tears down all 6 subscriptions', () => {
    handle.remove();
    handle = null as never; // prevent double-remove in afterEach
    // Emit events — they should NOT update the store anymore.
    DeviceEventEmitter.emit('duration', { elapsedMs: 9999, seq: 99 });
    expect(useRecordingStore.getState().elapsedMs).toBe(0);
  });
});
