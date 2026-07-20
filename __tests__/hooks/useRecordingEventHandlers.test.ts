/**
 * Tests for useRecordingEventHandlers — the pure factory functions that
 * build the 5 native event handlers ('location', 'duration', 'state',
 * 'saved', 'error').
 *
 * These factories are pure functions (no React imports beyond the
 * type-only MutableRefObject import), so we can test them directly
 * without renderHook — just call the factory with a params object and
 * invoke the returned handler with a synthetic event.
 *
 * Coverage:
 *   - 'location' handler updates distance / fixType / accuracy / hasFix.
 *   - 'location' handler pushes speed into recentSpeedsRef (and trims).
 *   - 'location' handler skips currentSpeed update when isAutoPausedRef.current=true.
 *   - 'duration' handler ignores out-of-order events via lastDurationSeqRef.
 *   - 'state' handler transitions to 'recording' when ev.isRecording=true.
 *   - 'state' handler transitions to 'idle' + resets GNSS when ev.isRecording=false.
 *   - 'saved' handler cancels the 1s stopTimeout + 15s stopHardTimeout.
 *   - 'saved' handler snapshots movingMs / elapsedMs / settings from refs.
 *   - 'error' handler with fatal=true resets recordingState to 'idle'.
 *   - 'error' handler with fatal=false does NOT reset.
 */
import {
  createLocationHandler,
  createDurationHandler,
  createStateHandler,
  createSavedHandler,
  createErrorHandler,
  SPEED_WINDOW,
} from '../../src/hooks/useRecordingEventHandlers';
import type {
  GpsLocationEvent,
  GpsDurationEvent,
  GpsStateEvent,
  GpsSavedEvent,
  GpsErrorEvent,
} from '../../src/NativeGpsRecorder';
import type { RecordingState } from '../../src/styles';
import { makeRef } from '../helpers';

// ---------------------------------------------------------------------------
// 'location' handler
// ---------------------------------------------------------------------------

describe('createLocationHandler', () => {
  function setup(overrides: { isAutoPaused?: boolean } = {}) {
    const setDistance = jest.fn();
    const setCurrentSpeed = jest.fn();
    const setFixType = jest.fn();
    const setAccuracy = jest.fn();
    const setHasFix = jest.fn();
    const setIsAutoPaused = jest.fn();
    const setSignalLost = jest.fn();
    const setMovingMs = jest.fn();
    const isAutoPausedRef = makeRef<boolean>(overrides.isAutoPaused ?? false);
    const recentSpeedsRef = makeRef<number[]>([]);
    const forceRerender = jest.fn();
    const handler = createLocationHandler({
      setDistance, setCurrentSpeed, setFixType, setAccuracy, setHasFix,
      setIsAutoPaused, setSignalLost, setMovingMs,
      isAutoPausedRef, recentSpeedsRef, forceRerender,
    });
    return {
      handler, setDistance, setCurrentSpeed, setFixType, setAccuracy,
      setHasFix, setIsAutoPaused, setSignalLost, setMovingMs,
      isAutoPausedRef, recentSpeedsRef, forceRerender,
    };
  }

  function makeEv(over: Partial<GpsLocationEvent> = {}): GpsLocationEvent {
    return {
      lat: 55.0, lon: 37.0, alt: 100.0,
      speed: 3.0, accuracy: 5.0,
      fixType: '3D fix', distance: 1500.0,
      timestamp: Date.now(), pointCount: 10,
      isAutoPaused: false, signalLost: false, movingMs: 10_000,
      ...over,
    };
  }

  it('updates distance / fixType / accuracy / hasFix from the event', () => {
    const s = setup();
    s.handler(makeEv({ distance: 1500, fixType: '3D fix', accuracy: 5 }));
    expect(s.setDistance).toHaveBeenCalledWith(1500);
    expect(s.setFixType).toHaveBeenCalledWith('3D fix');
    expect(s.setAccuracy).toHaveBeenCalledWith(5);
    expect(s.setHasFix).toHaveBeenCalledWith(true);
  });

  it('updates isAutoPaused / signalLost / movingMs from the event', () => {
    const s = setup();
    s.handler(makeEv({ isAutoPaused: true, signalLost: false, movingMs: 42_000 }));
    expect(s.setIsAutoPaused).toHaveBeenCalledWith(true);
    expect(s.setSignalLost).toHaveBeenCalledWith(false);
    expect(s.setMovingMs).toHaveBeenCalledWith(42_000);
  });

  it('pushes speed into recentSpeedsRef and forces a re-render', () => {
    const s = setup();
    s.handler(makeEv({ speed: 3.0 }));
    expect(s.recentSpeedsRef.current).toEqual([3.0]);
    expect(s.forceRerender).toHaveBeenCalledTimes(1);
    expect(s.setCurrentSpeed).toHaveBeenCalledWith(3.0);
  });

  it('trims the recentSpeedsRef to SPEED_WINDOW entries', () => {
    const s = setup();
    // Pre-fill the window.
    for (let i = 0; i < SPEED_WINDOW; i++) {
      s.handler(makeEv({ speed: i }));
    }
    // Now push one more — the oldest entry should be shifted out.
    s.handler(makeEv({ speed: 99 }));
    expect(s.recentSpeedsRef.current.length).toBe(SPEED_WINDOW);
    expect(s.recentSpeedsRef.current[SPEED_WINDOW - 1]).toBe(99);
  });

  it('does NOT push speed or call setCurrentSpeed when isAutoPausedRef.current=true', () => {
    const s = setup({ isAutoPaused: true });
    s.handler(makeEv({ speed: 3.0 }));
    expect(s.setCurrentSpeed).not.toHaveBeenCalled();
    expect(s.recentSpeedsRef.current).toEqual([]);
    expect(s.forceRerender).not.toHaveBeenCalled();
  });

  it('still updates other state (distance, fixType, etc.) even when auto-paused', () => {
    const s = setup({ isAutoPaused: true });
    s.handler(makeEv({ distance: 1500, fixType: '2D fix', accuracy: 10 }));
    expect(s.setDistance).toHaveBeenCalledWith(1500);
    expect(s.setFixType).toHaveBeenCalledWith('2D fix');
    expect(s.setAccuracy).toHaveBeenCalledWith(10);
  });

  it('handles missing speed (null) by not calling setCurrentSpeed', () => {
    const s = setup();
    s.handler(makeEv({ speed: null }));
    expect(s.setCurrentSpeed).not.toHaveBeenCalled();
    expect(s.recentSpeedsRef.current).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 'duration' handler
// ---------------------------------------------------------------------------

describe('createDurationHandler', () => {
  function setup() {
    const setElapsedMs = jest.fn();
    const setMovingMs = jest.fn();
    const lastDurationSeqRef = makeRef<number>(0);
    const handler = createDurationHandler({ setElapsedMs, setMovingMs, lastDurationSeqRef });
    return { handler, setElapsedMs, setMovingMs, lastDurationSeqRef };
  }

  function makeEv(over: Partial<GpsDurationEvent> = {}): GpsDurationEvent {
    return { elapsedMs: 5_000, ...over };
  }

  it('updates elapsedMs from the event', () => {
    const s = setup();
    s.handler(makeEv({ elapsedMs: 10_000 }));
    expect(s.setElapsedMs).toHaveBeenCalledWith(10_000);
  });

  it('updates movingMs from the event when present', () => {
    const s = setup();
    s.handler(makeEv({ elapsedMs: 5_000, movingMs: 4_000 }));
    expect(s.setMovingMs).toHaveBeenCalledWith(4_000);
  });

  it('does NOT call setMovingMs when movingMs is not present', () => {
    const s = setup();
    s.handler(makeEv({ elapsedMs: 5_000 }));
    expect(s.setMovingMs).not.toHaveBeenCalled();
  });

  it('updates lastDurationSeqRef with the event seq', () => {
    const s = setup();
    s.handler(makeEv({ elapsedMs: 5_000, seq: 7 }));
    expect(s.lastDurationSeqRef.current).toBe(7);
  });

  it('drops out-of-order events (seq <= last seen)', () => {
    const s = setup();
    s.handler(makeEv({ elapsedMs: 5_000, seq: 5 }));
    expect(s.setElapsedMs).toHaveBeenCalledWith(5_000);
    s.setElapsedMs.mockClear();
    // Out-of-order event with seq=3 (older) — should be dropped.
    s.handler(makeEv({ elapsedMs: 99_999, seq: 3 }));
    expect(s.setElapsedMs).not.toHaveBeenCalled();
  });

  it('drops events with seq equal to the last seen', () => {
    const s = setup();
    s.handler(makeEv({ elapsedMs: 5_000, seq: 5 }));
    s.setElapsedMs.mockClear();
    s.handler(makeEv({ elapsedMs: 99_999, seq: 5 }));
    expect(s.setElapsedMs).not.toHaveBeenCalled();
  });

  it('processes events with no seq field (legacy native modules)', () => {
    const s = setup();
    s.handler(makeEv({ elapsedMs: 5_000 })); // no seq
    expect(s.setElapsedMs).toHaveBeenCalledWith(5_000);
    // The ref should NOT be updated to a non-number.
    expect(s.lastDurationSeqRef.current).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 'state' handler
// ---------------------------------------------------------------------------

describe('createStateHandler', () => {
  function setup() {
    const setRecordingState = jest.fn();
    const setElapsedMs = jest.fn();
    const setDistance = jest.fn();
    const setCurrentSpeed = jest.fn();
    const setIsAutoPaused = jest.fn();
    const setSignalLost = jest.fn();
    const setMovingMs = jest.fn();
    const recordingStateRef = makeRef<RecordingState>('idle');
    const recentSpeedsRef = makeRef<number[]>([1, 2, 3]);
    const resetGnss = jest.fn();
    const handler = createStateHandler({
      setRecordingState, setElapsedMs, setDistance, setCurrentSpeed,
      setIsAutoPaused, setSignalLost, setMovingMs,
      recordingStateRef, recentSpeedsRef, resetGnss,
    });
    return {
      handler, setRecordingState, setElapsedMs, setDistance, setCurrentSpeed,
      setIsAutoPaused, setSignalLost, setMovingMs, recordingStateRef,
      recentSpeedsRef, resetGnss,
    };
  }

  function makeEv(over: Partial<GpsStateEvent> = {}): GpsStateEvent {
    return {
      isRecording: true,
      pointCount: 5,
      elapsedMs: 10_000,
      isAutoPaused: false,
      signalLost: false,
      movingMs: 8_000,
      ...over,
    };
  }

  it('transitions to "recording" + updates elapsed/autopause/signal/moving when ev.isRecording=true', () => {
    const s = setup();
    s.handler(makeEv({
      isRecording: true, elapsedMs: 10_000,
      isAutoPaused: false, signalLost: false, movingMs: 8_000,
    }));
    expect(s.recordingStateRef.current).toBe('recording');
    expect(s.setRecordingState).toHaveBeenCalledWith('recording');
    expect(s.setElapsedMs).toHaveBeenCalledWith(10_000);
    expect(s.setIsAutoPaused).toHaveBeenCalledWith(false);
    expect(s.setSignalLost).toHaveBeenCalledWith(false);
    expect(s.setMovingMs).toHaveBeenCalledWith(8_000);
  });

  it('transitions to "idle" + resets everything when ev.isRecording=false', () => {
    const s = setup();
    s.handler(makeEv({ isRecording: false }));
    expect(s.recordingStateRef.current).toBe('idle');
    expect(s.setRecordingState).toHaveBeenCalledWith('idle');
    expect(s.setElapsedMs).toHaveBeenCalledWith(0);
    expect(s.setDistance).toHaveBeenCalledWith(0);
    expect(s.setCurrentSpeed).toHaveBeenCalledWith(null);
    expect(s.resetGnss).toHaveBeenCalledTimes(1);
    expect(s.setIsAutoPaused).toHaveBeenCalledWith(false);
    expect(s.setSignalLost).toHaveBeenCalledWith(false);
    expect(s.setMovingMs).toHaveBeenCalledWith(0);
    // recentSpeedsRef should be cleared.
    expect(s.recentSpeedsRef.current).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 'saved' handler
// ---------------------------------------------------------------------------

describe('createSavedHandler', () => {
  function setup() {
    const setLastSavedMovingMs = jest.fn();
    const setLastSavedElapsedMs = jest.fn();
    const setLastSavedSettings = jest.fn();
    const setLastSavedPath = jest.fn();
    const setLastSavedDistance = jest.fn();
    const setElapsedMs = jest.fn();
    const setDistance = jest.fn();
    const setCurrentSpeed = jest.fn();
    const setFixType = jest.fn();
    const setHasFix = jest.fn();
    const setRecordingState = jest.fn();
    const setIsAutoPaused = jest.fn();
    const setSignalLost = jest.fn();
    const setMovingMs = jest.fn();
    const stopTimeoutRef = makeRef<number | null>(12345); // simulate an active timer id
    const stopHardTimeoutRef = makeRef<number | null>(23456);
    const movingMsRef = makeRef<number>(42_000);
    const elapsedMsRef = makeRef<number>(60_000);
    const autoPauseEnabledRef = makeRef<boolean>(true);
    const gapDetectionEnabledRef = makeRef<boolean>(false);
    const showMovingTimeRef = makeRef<boolean>(true);
    const recordingStateRef = makeRef<RecordingState>('stopping');
    const recentSpeedsRef = makeRef<number[]>([1, 2, 3]);
    const handler = createSavedHandler({
      setLastSavedMovingMs, setLastSavedElapsedMs, setLastSavedSettings,
      setLastSavedPath, setLastSavedDistance, setElapsedMs, setDistance,
      setCurrentSpeed, setFixType, setHasFix, setRecordingState,
      setIsAutoPaused, setSignalLost, setMovingMs,
      stopTimeoutRef, stopHardTimeoutRef,
      movingMsRef, elapsedMsRef,
      autoPauseEnabledRef, gapDetectionEnabledRef, showMovingTimeRef,
      recordingStateRef, recentSpeedsRef,
    });
    return {
      handler, setLastSavedMovingMs, setLastSavedElapsedMs, setLastSavedSettings,
      setLastSavedPath, setLastSavedDistance, setElapsedMs, setDistance,
      setCurrentSpeed, setFixType, setHasFix, setRecordingState,
      setIsAutoPaused, setSignalLost, setMovingMs,
      stopTimeoutRef, stopHardTimeoutRef,
      movingMsRef, elapsedMsRef,
      autoPauseEnabledRef, gapDetectionEnabledRef, showMovingTimeRef,
      recordingStateRef, recentSpeedsRef,
    };
  }

  function makeEv(over: Partial<GpsSavedEvent> = {}): GpsSavedEvent {
    return {
      filePath: '/path/to/file.gpx',
      pointCount: 100,
      finalDistanceM: 1500,
      ...over,
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('cancels the stop timeout (clearTimeout called)', () => {
    const s = setup();
    const clearSpy = jest.spyOn(globalThis, 'clearTimeout');
    s.handler(makeEv());
    expect(clearSpy).toHaveBeenCalledWith(12345);
    expect(s.stopTimeoutRef.current).toBeNull();
  });

  it('cancels the hard fallback timeout (H4 fix)', () => {
    const s = setup();
    const clearSpy = jest.spyOn(globalThis, 'clearTimeout');
    s.handler(makeEv());
    expect(clearSpy).toHaveBeenCalledWith(23456);
    expect(s.stopHardTimeoutRef.current).toBeNull();
  });

  it('snapshots movingMs / elapsedMs from refs BEFORE resetting', () => {
    const s = setup();
    s.handler(makeEv());
    expect(s.setLastSavedMovingMs).toHaveBeenCalledWith(42_000);
    expect(s.setLastSavedElapsedMs).toHaveBeenCalledWith(60_000);
  });

  it('snapshots the settings from refs (auto-pause / gap-detection / show-moving-time)', () => {
    const s = setup();
    s.handler(makeEv());
    expect(s.setLastSavedSettings).toHaveBeenCalledWith({
      autoPauseEnabled: true,
      gapDetectionEnabled: false,
      showMovingTime: true,
    });
  });

  it('sets lastSavedPath from the event filePath', () => {
    const s = setup();
    s.handler(makeEv({ filePath: '/foo/bar.gpx' }));
    expect(s.setLastSavedPath).toHaveBeenCalledWith('/foo/bar.gpx');
  });

  it('sets lastSavedDistance from finalDistanceM when >= 0', () => {
    const s = setup();
    s.handler(makeEv({ finalDistanceM: 1500 }));
    expect(s.setLastSavedDistance).toHaveBeenCalledWith(1500);
  });

  it('sets lastSavedDistance to null when finalDistanceM is negative', () => {
    const s = setup();
    s.handler(makeEv({ finalDistanceM: -1 }));
    expect(s.setLastSavedDistance).toHaveBeenCalledWith(null);
  });

  it('sets lastSavedDistance to null when finalDistanceM is missing', () => {
    const s = setup();
    s.handler(makeEv({ finalDistanceM: undefined }));
    expect(s.setLastSavedDistance).toHaveBeenCalledWith(null);
  });

  it('resets elapsedMs / distance / currentSpeed / fixType / hasFix after saving', () => {
    const s = setup();
    s.handler(makeEv());
    expect(s.setElapsedMs).toHaveBeenCalledWith(0);
    expect(s.setDistance).toHaveBeenCalledWith(0);
    expect(s.setCurrentSpeed).toHaveBeenCalledWith(null);
    expect(s.setFixType).toHaveBeenCalledWith('no fix');
    expect(s.setHasFix).toHaveBeenCalledWith(false);
  });

  it('transitions recordingState to "idle" (ref + setState)', () => {
    const s = setup();
    s.handler(makeEv());
    expect(s.recordingStateRef.current).toBe('idle');
    expect(s.setRecordingState).toHaveBeenCalledWith('idle');
  });

  it('clears isAutoPaused / signalLost / movingMs / recentSpeedsRef', () => {
    const s = setup();
    s.handler(makeEv());
    expect(s.setIsAutoPaused).toHaveBeenCalledWith(false);
    expect(s.setSignalLost).toHaveBeenCalledWith(false);
    expect(s.setMovingMs).toHaveBeenCalledWith(0);
    expect(s.recentSpeedsRef.current).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 'error' handler
// ---------------------------------------------------------------------------

describe('createErrorHandler', () => {
  function setup() {
    const setErrorMsg = jest.fn();
    const setRecordingState = jest.fn();
    const recordingStateRef = makeRef<RecordingState>('recording');
    const handler = createErrorHandler({
      setErrorMsg, setRecordingState, recordingStateRef,
    });
    return { handler, setErrorMsg, setRecordingState, recordingStateRef };
  }

  function makeEv(over: Partial<GpsErrorEvent> = {}): GpsErrorEvent {
    return { message: 'something broke', ...over };
  }

  it('sets the error message from the event', () => {
    const s = setup();
    s.handler(makeEv({ message: 'no permissions' }));
    expect(s.setErrorMsg).toHaveBeenCalledWith('no permissions');
  });

  it('with fatal=true: resets recordingState to "idle" (ref + setState)', () => {
    const s = setup();
    s.handler(makeEv({ message: 'x', fatal: true }));
    expect(s.recordingStateRef.current).toBe('idle');
    expect(s.setRecordingState).toHaveBeenCalledWith('idle');
  });

  it('with fatal=false: does NOT reset recordingState (informational error)', () => {
    const s = setup();
    s.handler(makeEv({ message: 'x', fatal: false }));
    expect(s.recordingStateRef.current).toBe('recording');
    expect(s.setRecordingState).not.toHaveBeenCalled();
  });

  it('with fatal absent (undefined): treats as non-fatal (no reset)', () => {
    const s = setup();
    s.handler(makeEv({ message: 'x' })); // fatal absent
    expect(s.recordingStateRef.current).toBe('recording');
    expect(s.setRecordingState).not.toHaveBeenCalled();
  });
});
