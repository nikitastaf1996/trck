/**
 * Native GpsRecorder module TypeScript declarations.
 *
 * The actual implementation lives in:
 *   android/app/src/main/java/com/gpsrecorder/GpsRecorderModule.kt
 */

import { NativeModules, DeviceEventEmitter, EmitterSubscription } from 'react-native';

export type GpsFixType = 'no fix' | '2D fix' | '3D fix';

export type GpsLocationEvent = {
  lat: number;
  lon: number;
  alt: number | null;
  speed: number | null; // m/s
  accuracy: number | null; // meters
  fixType: GpsFixType;   // GNSS fix status (no fix / 2D fix / 3D fix)
  distance: number;      // total distance traveled so far, meters
  timestamp: number; // epoch ms
  pointCount: number;
  // Phase 1/3/4: auto-pause / signal-lost / moving-time so the UI can
  // reflect pause / gap status in real time. These are emitted on every
  // 'location' event alongside the rest of the fix data.
  isAutoPaused: boolean;  // true while auto-pause is active (user stationary)
  signalLost: boolean;    // true while the gap watchdog has declared signal lost
  movingMs: number;       // active moving time (excludes auto-paused intervals)
};

export type GpsDurationEvent = {
  elapsedMs: number;
};

export type GpsStateEvent = {
  isRecording: boolean;
  pointCount: number;
  elapsedMs: number;
  // Phase 1/3/4: same live state fields as GpsLocationEvent, so the UI
  // can sync pause / signal / moving-time from getState() polling even
  // when event delivery is unreliable.
  isAutoPaused: boolean;
  signalLost: boolean;
  movingMs: number;
};

export type GpsSavedEvent = {
  filePath: string;
  pointCount: number;
  // Final distance (meters) computed from the SAVED GPX file, post-smoothing
  // / post-filtering. Negative when not available; the UI should keep the
  // live-accumulated distance in that case.
  finalDistanceM?: number;
};

export type GpsErrorEvent = {
  message: string;
};

/**
 * Live GNSS status event, independent of recording. Emitted by the always-on
 * monitor (GpsRecorderModule.startGnssMonitor) so the UI can show fix status
 * BEFORE the user starts recording. Also still useful while recording.
 */
export type GpsGnssEvent = {
  fixType: GpsFixType;
  accuracy: number | null;        // meters, null when no fix
  satellitesUsed: number;
  satellitesInView: number;
  hasFix: boolean;
  lat: number | null;
  lon: number | null;
  alt: number | null;
  speed: number | null;           // m/s
  timestamp: number;              // epoch ms
};

export type GpsFullState = {
  isRecording: boolean;
  pointCount: number;
  elapsedMs: number;
  distance: number;          // total distance traveled, meters
  fixType: GpsFixType;       // GNSS fix status
  lastFix: GpsLocationEvent | null;
  // Phase 1/3/4: live state for auto-pause / signal-loss / moving-time.
  // These come from the per-recording prefs so they survive service
  // restarts and are always available via getState() polling.
  isAutoPaused: boolean;
  signalLost: boolean;
  movingMs: number;
};

export type GpsRecorderEvents = {
  location: GpsLocationEvent;
  duration: GpsDurationEvent;
  state: GpsStateEvent;
  saved: GpsSavedEvent;
  error: GpsErrorEvent;
  gnss: GpsGnssEvent;
};

type GpsRecorderNativeType = {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRecording(): Promise<boolean>;
  getState(): Promise<GpsFullState>;
  requestPermissions(): Promise<boolean>;
  hasPermissions(): Promise<boolean>;
  requestIgnoreBatteryOptimizations(): Promise<boolean>;
  openAppSettings(): Promise<void>;
  startGnssMonitor(): Promise<boolean>;
  stopGnssMonitor(): Promise<boolean>;
  setPostProcessEnabled(enabled: boolean): Promise<boolean>;
  getPostProcessEnabled(): Promise<boolean>;
  setGaussianSmoothingEnabled(enabled: boolean): Promise<boolean>;
  getGaussianSmoothingEnabled(): Promise<boolean>;
  // Phase 1: auto-pause (stop detection) toggle. Persisted in the separate
  // settings prefs file so it survives the per-recording state clear.
  setAutoPauseEnabled(enabled: boolean): Promise<boolean>;
  getAutoPauseEnabled(): Promise<boolean>;
  // Phase 4: gap detection (signal loss) toggle. Defaults to true so
  // existing users keep the behaviour from the previous APK. When off,
  // signal outages do NOT split the track into a new <trkseg> and the
  // signal-lost UI banner never appears.
  setGapDetectionEnabled(enabled: boolean): Promise<boolean>;
  getGapDetectionEnabled(): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

const NativeGpsRecorder = (NativeModules.GpsRecorder as GpsRecorderNativeType) || {
  start: async () => {},
  stop: async () => {},
  isRecording: async () => false,
  getState: async () => ({
    isRecording: false,
    pointCount: 0,
    elapsedMs: 0,
    distance: 0,
    fixType: 'no fix' as GpsFixType,
    lastFix: null,
    isAutoPaused: false,
    signalLost: false,
    movingMs: 0,
  }),
  requestPermissions: async () => false,
  hasPermissions: async () => false,
  requestIgnoreBatteryOptimizations: async () => false,
  openAppSettings: async () => {},
  startGnssMonitor: async () => false,
  stopGnssMonitor: async () => false,
  setPostProcessEnabled: async (_enabled: boolean) => false,
  getPostProcessEnabled: async () => false,
  setGaussianSmoothingEnabled: async (_enabled: boolean) => false,
  getGaussianSmoothingEnabled: async () => false,
  setAutoPauseEnabled: async (_enabled: boolean) => false,
  getAutoPauseEnabled: async () => false,
  setGapDetectionEnabled: async (_enabled: boolean) => false,
  getGapDetectionEnabled: async () => true,
  addListener: () => {},
  removeListeners: () => {},
};

export const GpsRecorder = {
  start: () => NativeGpsRecorder.start(),
  stop: () => NativeGpsRecorder.stop(),
  isRecording: () => NativeGpsRecorder.isRecording(),
  getState: () => NativeGpsRecorder.getState(),
  requestPermissions: () => NativeGpsRecorder.requestPermissions(),
  hasPermissions: () => NativeGpsRecorder.hasPermissions(),
  requestIgnoreBatteryOptimizations: () => NativeGpsRecorder.requestIgnoreBatteryOptimizations(),
  openAppSettings: () => NativeGpsRecorder.openAppSettings(),
  startGnssMonitor: () => NativeGpsRecorder.startGnssMonitor(),
  stopGnssMonitor: () => NativeGpsRecorder.stopGnssMonitor(),
  setPostProcessEnabled: (enabled: boolean) => NativeGpsRecorder.setPostProcessEnabled(enabled),
  getPostProcessEnabled: () => NativeGpsRecorder.getPostProcessEnabled(),
  setGaussianSmoothingEnabled: (enabled: boolean) => NativeGpsRecorder.setGaussianSmoothingEnabled(enabled),
  getGaussianSmoothingEnabled: () => NativeGpsRecorder.getGaussianSmoothingEnabled(),
  setAutoPauseEnabled: (enabled: boolean) => NativeGpsRecorder.setAutoPauseEnabled(enabled),
  getAutoPauseEnabled: () => NativeGpsRecorder.getAutoPauseEnabled(),
  setGapDetectionEnabled: (enabled: boolean) => NativeGpsRecorder.setGapDetectionEnabled(enabled),
  getGapDetectionEnabled: () => NativeGpsRecorder.getGapDetectionEnabled(),
};

/**
 * Subscribe to a native event.
 *
 * Uses DeviceEventEmitter directly (instead of NativeEventEmitter) because it is
 * the most reliable event delivery mechanism on Android — the Kotlin side emits
 * via RCTDeviceEventEmitter, which maps 1:1 to DeviceEventEmitter on JS.
 */
export function subscribe<K extends keyof GpsRecorderEvents>(
  event: K,
  handler: (payload: GpsRecorderEvents[K]) => void
): EmitterSubscription {
  return DeviceEventEmitter.addListener(event, handler as (p: unknown) => void);
}
