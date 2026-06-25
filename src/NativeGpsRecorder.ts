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
};

export type GpsDurationEvent = {
  elapsedMs: number;
};

export type GpsStateEvent = {
  isRecording: boolean;
  pointCount: number;
  elapsedMs: number;
};

export type GpsSavedEvent = {
  filePath: string;
  pointCount: number;
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
