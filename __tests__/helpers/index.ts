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

/** Reset all mock call history on the GpsRecorder mock. */
export function clearGpsMock(): void {
  for (const k of Object.keys(gpsMock)) {
    const fn = gpsMock[k];
    if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
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
 * for tests that fire an async hook handler and want to assert on the
 * resulting state updates before the test exits.
 */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Build a minimal `MutableRefObject<T>` for tests that pass refs into hooks.
 * The ref is a plain object — `current` is mutable, no React ref machinery.
 */
export function makeRef<T>(initial: T): { current: T } {
  return { current: initial };
}
