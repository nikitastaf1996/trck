/**
 * Shared test helpers for the trck Jest suite.
 *
 * Importing from here is optional — individual tests can do everything
 * inline — but using these helpers keeps tests concise and ensures the
 * mocks are reset consistently between `it` blocks.
 */
import { NativeModules } from 'react-native';

/**
 * The mock GpsRecorder native module (registered in jest.setup.js).
 * Every test that asserts on native-module interactions should call
 * `clearGpsMock()` at the top of its `beforeEach`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const gpsMock = (globalThis as any).__gpsRecorderMock as {
  [k: string]: jest.Mock;
};

/**
 * Reset all mock state on the GpsRecorder mock — call history AND
 * implementations. Re-establishes the default resolved values from
 * jest.setup.js so each test starts from a clean slate.
 *
 * Uses `mockReset()` (not `mockClear()`) because `mockClear()` only
 * clears call history, not `mockResolvedValue` / `mockResolvedValueOnce`
 * queues — those would leak across tests, causing the second `once`
 * value from a previous test to be returned unexpectedly.
 */
export function clearGpsMock(): void {
  // Default resolved values — must match jest.setup.js.
  const defaults: Record<string, unknown> = {
    start: undefined,
    stop: undefined,
    getState: {
      isRecording: false,
      pointCount: 0,
      elapsedMs: 0,
      distance: 0,
      fixType: 'no fix',
      lastFix: null,
      isAutoPaused: false,
      signalLost: false,
      movingMs: 0,
    },
    requestPermissions: true,
    hasPermissions: true,
    requestIgnoreBatteryOptimizations: true,
    openAppSettings: undefined,
    startGnssMonitor: true,
    stopGnssMonitor: true,
    setPostProcessEnabled: true,
    getPostProcessEnabled: false,
    setGaussianSmoothingEnabled: true,
    getGaussianSmoothingEnabled: false,
    setRadialDistanceFilterEnabled: true,
    getRadialDistanceFilterEnabled: false,
    setRadialDistanceThresholdM: 5,
    getRadialDistanceThresholdM: 5,
    setTimeSamplingEnabled: true,
    getTimeSamplingEnabled: false,
    setTimeSamplingN: 5,
    getTimeSamplingN: 5,
    setDouglasPeuckerEnabled: true,
    getDouglasPeuckerEnabled: false,
    setDouglasPeuckerEpsilonM: 5.0,
    getDouglasPeuckerEpsilonM: 5.0,
    setAutoPauseEnabled: true,
    getAutoPauseEnabled: false,
    setGapDetectionEnabled: true,
    getGapDetectionEnabled: true,
    setShowMovingTimeEnabled: true,
    getShowMovingTimeEnabled: false,
  };
  for (const k of Object.keys(gpsMock)) {
    const fn = gpsMock[k];
    if (typeof fn === 'function' && 'mockReset' in fn) {
      fn.mockReset();
      if (k in defaults) {
        fn.mockResolvedValue(defaults[k]);
      }
    }
  }
}

/** Force the native module to look "not loaded" by deleting NativeModules.GpsRecorder. */
export function hideNativeModule(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__gpsRecorderCache = NativeModules.GpsRecorder;
  delete NativeModules.GpsRecorder;
}

/** Restore NativeModules.GpsRecorder after a hideNativeModule() call. */
export function restoreNativeModule(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cache = (globalThis as any).__gpsRecorderCache;
  if (cache !== undefined) {
    NativeModules.GpsRecorder = cache as typeof NativeModules.GpsRecorder;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__gpsRecorderCache;
  }
}

/**
 * Wait for all queued microtasks (Promise resolutions) to drain. Useful
 * for tests that fire an async store action and want to assert on the
 * resulting state updates before the test exits.
 */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Reset both Zustand stores to their initial state. Call this in
 * `beforeEach` for any test that exercises the stores, so a leak in
 * one test doesn't poison assertions in the next.
 *
 * IMPORTANT: use `setState(partial)` (merge mode), NOT `setState(partial, true)`
 * (replace mode). Replace mode nukes the action functions, leaving the
 * store with only data fields and breaking every subsequent call.
 */
export function resetStores(): void {
  // Lazy require so the helpers file doesn't pull in the stores (and
  // therefore the native module mock) at import time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useRecordingStore } = require('../../src/store/recordingStore');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useSettingsStore } = require('../../src/store/settingsStore');
  useRecordingStore.setState({
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
  });
  useSettingsStore.setState({
    postProcessEnabled: false,
    gaussianSmoothingEnabled: false,
    autoPauseEnabled: false,
    gapDetectionEnabled: true,
    showMovingTime: false,
    radialDistanceFilterEnabled: false,
    radialDistanceThresholdM: 5,
    timeSamplingEnabled: false,
    timeSamplingN: 5,
    douglasPeuckerEnabled: false,
    douglasPeuckerEpsilonM: 5,
    _updating: false,
  });
}

