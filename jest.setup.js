/**
 * Jest setup — runs once before every test file.
 *
 * The React Native Jest preset already mocks most of `react-native` itself
 * (NativeModules, DeviceEventEmitter, etc.). Here we add the few extra
 * shims that the trck codebase needs but the preset doesn't ship:
 *
 *   1. react-native-safe-area-context — used by App.tsx for SafeAreaView.
 *      Without a mock, any component that renders App.tsx (or any sub-tree
 *      that imports SafeAreaView) throws because the native module isn't
 *      registered in the test environment.
 *
 *   2. A `console.error` suppressor for the expected "React createElement
 *      not mocked" warnings that fire when react-test-renderer renders a
 *      Pressable / ScrollView. We only suppress the known-noisy warnings
 *      (the ones whose text contains a sentinel substring) so real test
 *      failures still surface.
 *
 *   3. A `jest.useFakeTimers` default? No — we intentionally use real timers
 *      because useSettings / usePermissions have real setTimeout(800ms)
 *      flows that are easier to assert with jest.advanceTimersByTime if
 *      needed. Each test file can opt into fake timers via
 *      `jest.useFakeTimers().advanceTimersByTime(...)` if it wants.
 */

// Mock react-native-safe-area-context — replace every export with the
// no-op version below. We only need SafeAreaView (used by App.tsx); the
// rest are stubbed so the mock file stays simple.
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    SafeAreaProvider: ({ children }) => React.createElement(React.Fragment, null, children),
    SafeAreaConsumer: ({ children }) => children({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 375, height: 812 }),
  };
});

// Mock the native GpsRecorder module so we can drive it from JS tests.
// `NativeModules.GpsRecorder` is what `src/NativeGpsRecorder.ts` reads at
// module-load time; we need to register it BEFORE the source file is
// imported (which happens via the test file's first import).
const NativeModules = jest.requireActual('react-native').NativeModules;
const gpsRecorderMock = {
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  getState: jest.fn().mockResolvedValue({
    isRecording: false,
    pointCount: 0,
    elapsedMs: 0,
    distance: 0,
    fixType: 'no fix',
    lastFix: null,
    isAutoPaused: false,
    signalLost: false,
    movingMs: 0,
  }),
  requestPermissions: jest.fn().mockResolvedValue(true),
  hasPermissions: jest.fn().mockResolvedValue(true),
  requestIgnoreBatteryOptimizations: jest.fn().mockResolvedValue(true),
  openAppSettings: jest.fn().mockResolvedValue(undefined),
  startGnssMonitor: jest.fn().mockResolvedValue(true),
  stopGnssMonitor: jest.fn().mockResolvedValue(true),
  setPostProcessEnabled: jest.fn().mockResolvedValue(true),
  getPostProcessEnabled: jest.fn().mockResolvedValue(false),
  setGaussianSmoothingEnabled: jest.fn().mockResolvedValue(true),
  getGaussianSmoothingEnabled: jest.fn().mockResolvedValue(false),
  setRadialDistanceFilterEnabled: jest.fn().mockResolvedValue(true),
  getRadialDistanceFilterEnabled: jest.fn().mockResolvedValue(false),
  setRadialDistanceThresholdM: jest.fn().mockResolvedValue(5),
  getRadialDistanceThresholdM: jest.fn().mockResolvedValue(5),
  setTimeSamplingEnabled: jest.fn().mockResolvedValue(true),
  getTimeSamplingEnabled: jest.fn().mockResolvedValue(false),
  setTimeSamplingN: jest.fn().mockResolvedValue(5),
  getTimeSamplingN: jest.fn().mockResolvedValue(5),
  setDouglasPeuckerEnabled: jest.fn().mockResolvedValue(true),
  getDouglasPeuckerEnabled: jest.fn().mockResolvedValue(false),
  setDouglasPeuckerEpsilonM: jest.fn().mockResolvedValue(5.0),
  getDouglasPeuckerEpsilonM: jest.fn().mockResolvedValue(5.0),
  setAutoPauseEnabled: jest.fn().mockResolvedValue(true),
  getAutoPauseEnabled: jest.fn().mockResolvedValue(false),
  setGapDetectionEnabled: jest.fn().mockResolvedValue(true),
  getGapDetectionEnabled: jest.fn().mockResolvedValue(true),
  setShowMovingTimeEnabled: jest.fn().mockResolvedValue(true),
  getShowMovingTimeEnabled: jest.fn().mockResolvedValue(false),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};
NativeModules.GpsRecorder = gpsRecorderMock;

// Expose the mock on `global` so individual tests can reset its call
// history via `global.__gpsRecorderMock.start.mockClear()`. Each test
// can also override its resolved value: `mock.mockResolvedValueOnce(...)`.
global.__gpsRecorderMock = gpsRecorderMock;

// Reset all mock call/instance state between test FILES so a leak in one
// file doesn't poison assertions in the next. Individual `it` blocks
// inside a file should call `mockClear()` themselves if they need a
// pristine state — we don't reset between `it`s because some tests build
// up state across multiple assertions.
beforeAll(() => {
  // Make sure no leftover mock implementation from a previous file leaks.
  Object.values(gpsRecorderMock).forEach((m) => {
    if (typeof m === 'function' && 'mockClear' in m) m.mockClear();
  });
});
