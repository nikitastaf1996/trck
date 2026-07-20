/**
 * Tests for the GpsRecorder TS-side wrapper around NativeModules.GpsRecorder.
 *
 * Coverage:
 *   - isNativeModuleAvailable detects a registered module with a `start` function.
 *   - isNativeModuleAvailable returns false when the module is absent.
 *   - Each wrapper method on the `GpsRecorder` object delegates to the matching
 *     native method with the right argument shape.
 *   - `subscribe()` returns the EmitterSubscription registered with DeviceEventEmitter.
 *   - The fallback no-op object is used when NativeModules.GpsRecorder is undefined.
 */
import { NativeModules, DeviceEventEmitter } from 'react-native';
import {
  GpsRecorder,
  subscribe,
  isNativeModuleAvailable,
} from '../src/NativeGpsRecorder';
import { clearGpsMock, hideNativeModule, restoreNativeModule } from './helpers';

// Cache the original mock so each test can restore it without depending on
// jest.resetModules() (which would also reset the React Native mock registry
// and lose all the NativeModules.GpsRecorder setup work).
const ORIGINAL_MOCK = NativeModules.GpsRecorder;

describe('isNativeModuleAvailable', () => {
  afterEach(() => {
    // Restore the original mock so subsequent describe blocks see a clean
    // state. We do NOT call jest.resetModules() — that would also reset
    // the react-native module and lose our GpsRecorder mock registration.
    NativeModules.GpsRecorder = ORIGINAL_MOCK;
  });

  it('returns true when NativeModules.GpsRecorder.start is a function', () => {
    // The constant was captured at the source-file import. The jest.setup.js
    // mock registers NativeModules.GpsRecorder.start as a jest.fn — so the
    // module-level `isNativeModuleAvailable` constant is `true`.
    expect(isNativeModuleAvailable).toBe(true);
  });

  it('returns false when NativeModules.GpsRecorder is undefined', () => {
    hideNativeModule();
    // Re-import inside an isolated module registry so the module-level
    // `isNativeModuleAvailable` constant re-evaluates against the deleted
    // NativeModules.GpsRecorder.
    jest.isolateModules(() => {
      const mod = require('../src/NativeGpsRecorder');
      expect(mod.isNativeModuleAvailable).toBe(false);
    });
  });

  it('returns false when NativeModules.GpsRecorder exists but `start` is not a function', () => {
    NativeModules.GpsRecorder = { start: 'not a function' } as unknown as typeof ORIGINAL_MOCK;
    jest.isolateModules(() => {
      const mod = require('../src/NativeGpsRecorder');
      expect(mod.isNativeModuleAvailable).toBe(false);
    });
  });
});

describe('GpsRecorder wrapper', () => {
  beforeEach(() => {
    clearGpsMock();
  });

  it('GpsRecorder.start delegates to NativeModules.GpsRecorder.start', async () => {
    await GpsRecorder.start();
    expect(NativeModules.GpsRecorder!.start).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.start).toHaveBeenCalledWith();
  });

  it('GpsRecorder.stop delegates to NativeModules.GpsRecorder.stop', async () => {
    await GpsRecorder.stop();
    expect(NativeModules.GpsRecorder!.stop).toHaveBeenCalledTimes(1);
  });

  it('GpsRecorder.getState delegates and returns the full state object', async () => {
    const state = await GpsRecorder.getState();
    expect(NativeModules.GpsRecorder!.getState).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      isRecording: false,
      pointCount: 0,
      elapsedMs: 0,
      distance: 0,
    });
  });

  it('boolean setters forward the boolean argument verbatim', async () => {
    await GpsRecorder.setPostProcessEnabled(true);
    await GpsRecorder.setGaussianSmoothingEnabled(false);
    await GpsRecorder.setAutoPauseEnabled(true);
    await GpsRecorder.setGapDetectionEnabled(false);
    await GpsRecorder.setShowMovingTimeEnabled(true);
    await GpsRecorder.setRadialDistanceFilterEnabled(true);
    await GpsRecorder.setTimeSamplingEnabled(true);
    await GpsRecorder.setDouglasPeuckerEnabled(true);
    expect(NativeModules.GpsRecorder!.setPostProcessEnabled).toHaveBeenCalledWith(true);
    expect(NativeModules.GpsRecorder!.setGaussianSmoothingEnabled).toHaveBeenCalledWith(false);
    expect(NativeModules.GpsRecorder!.setAutoPauseEnabled).toHaveBeenCalledWith(true);
    expect(NativeModules.GpsRecorder!.setGapDetectionEnabled).toHaveBeenCalledWith(false);
    expect(NativeModules.GpsRecorder!.setShowMovingTimeEnabled).toHaveBeenCalledWith(true);
    expect(NativeModules.GpsRecorder!.setRadialDistanceFilterEnabled).toHaveBeenCalledWith(true);
    expect(NativeModules.GpsRecorder!.setTimeSamplingEnabled).toHaveBeenCalledWith(true);
    expect(NativeModules.GpsRecorder!.setDouglasPeuckerEnabled).toHaveBeenCalledWith(true);
  });

  it('numeric setters forward the number argument verbatim', async () => {
    await GpsRecorder.setRadialDistanceThresholdM(42);
    await GpsRecorder.setTimeSamplingN(7);
    await GpsRecorder.setDouglasPeuckerEpsilonM(12.5);
    expect(NativeModules.GpsRecorder!.setRadialDistanceThresholdM).toHaveBeenCalledWith(42);
    expect(NativeModules.GpsRecorder!.setTimeSamplingN).toHaveBeenCalledWith(7);
    expect(NativeModules.GpsRecorder!.setDouglasPeuckerEpsilonM).toHaveBeenCalledWith(12.5);
  });

  it('boolean getters pass through to native getters', async () => {
    await GpsRecorder.getPostProcessEnabled();
    await GpsRecorder.getGaussianSmoothingEnabled();
    await GpsRecorder.getAutoPauseEnabled();
    await GpsRecorder.getGapDetectionEnabled();
    await GpsRecorder.getShowMovingTimeEnabled();
    await GpsRecorder.getRadialDistanceFilterEnabled();
    await GpsRecorder.getTimeSamplingEnabled();
    await GpsRecorder.getDouglasPeuckerEnabled();
    expect(NativeModules.GpsRecorder!.getPostProcessEnabled).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.getGaussianSmoothingEnabled).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.getAutoPauseEnabled).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.getGapDetectionEnabled).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.getShowMovingTimeEnabled).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.getRadialDistanceFilterEnabled).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.getTimeSamplingEnabled).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.getDouglasPeuckerEnabled).toHaveBeenCalledTimes(1);
  });

  it('numeric getters pass through to native getters', async () => {
    await GpsRecorder.getRadialDistanceThresholdM();
    await GpsRecorder.getTimeSamplingN();
    await GpsRecorder.getDouglasPeuckerEpsilonM();
    expect(NativeModules.GpsRecorder!.getRadialDistanceThresholdM).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.getTimeSamplingN).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.getDouglasPeuckerEpsilonM).toHaveBeenCalledTimes(1);
  });

  it('permission + battery-optimization helpers delegate to native methods', async () => {
    await GpsRecorder.requestPermissions();
    await GpsRecorder.hasPermissions();
    await GpsRecorder.requestIgnoreBatteryOptimizations();
    await GpsRecorder.openAppSettings();
    expect(NativeModules.GpsRecorder!.requestPermissions).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.hasPermissions).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.requestIgnoreBatteryOptimizations).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.openAppSettings).toHaveBeenCalledTimes(1);
  });

  it('GNSS monitor start/stop delegate to native methods', async () => {
    await GpsRecorder.startGnssMonitor();
    await GpsRecorder.stopGnssMonitor();
    expect(NativeModules.GpsRecorder!.startGnssMonitor).toHaveBeenCalledTimes(1);
    expect(NativeModules.GpsRecorder!.stopGnssMonitor).toHaveBeenCalledTimes(1);
  });

  it('uses the fallback no-op object when the native module is missing', () => {
    hideNativeModule();
    jest.isolateModules(() => {
      const mod = require('../src/NativeGpsRecorder');
      // The wrapper should NOT throw — it should resolve with the fallback
      // defaults. We don't assert on the resolved value because the fallback
      // returns the constant defaults declared in NativeGpsRecorder.ts.
      expect(() => mod.GpsRecorder.getState()).not.toThrow();
      expect(() => mod.GpsRecorder.setPostProcessEnabled(true)).not.toThrow();
      expect(() => mod.GpsRecorder.start()).not.toThrow();
    });
    restoreNativeModule();
  });
});

describe('subscribe', () => {
  it('returns an EmitterSubscription registered with DeviceEventEmitter', () => {
    const handler = jest.fn();
    const sub = subscribe('location', handler);
    // The returned subscription should have a `.remove()` method (the
    // EmitterSubscription interface contract).
    expect(sub).toBeDefined();
    expect(typeof sub.remove).toBe('function');
    // Firing the event should invoke the handler.
    DeviceEventEmitter.emit('location', { lat: 1, lon: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
    sub.remove();
    // After remove, the handler should NOT fire on subsequent emissions.
    DeviceEventEmitter.emit('location', { lat: 3, lon: 4 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not throw when subscribing to an unknown event name (runtime escape hatch)', () => {
    // The `subscribe` function's signature is typed as
    // `(event: K, handler: ...) => EmitterSubscription` where K is a
    // key of GpsRecorderEvents — so the compiler would normally reject
    // an unknown event name. At runtime, however, subscribe is just a
    // thin wrapper around DeviceEventEmitter.addListener, so an unknown
    // event name is harmless (no listeners are registered, the handler
    // never fires). This test verifies that the runtime behavior matches
    // the source comment.
    const handler = jest.fn();
    // Cast to bypass the typed signature — we're explicitly testing
    // the runtime behavior with an unknown event name.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => subscribe('unknown-event' as any, handler)).not.toThrow();
  });
});
