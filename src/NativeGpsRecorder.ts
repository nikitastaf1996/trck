/**
 * Native GpsRecorder module TypeScript declarations.
 *
 * The actual implementation lives in:
 *   android/app/src/main/java/com/gpsrecorder/GpsRecorderModule.kt
 */

import { NativeModules, DeviceEventEmitter, EmitterSubscription } from 'react-native';

export type GpsLocationEvent = {
  lat: number;
  lon: number;
  alt: number | null;
  speed: number | null; // m/s
  accuracy: number | null; // meters
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

export type GpsFullState = {
  isRecording: boolean;
  pointCount: number;
  elapsedMs: number;
  lastFix: GpsLocationEvent | null;
};

export type GpsRecorderEvents = {
  location: GpsLocationEvent;
  duration: GpsDurationEvent;
  state: GpsStateEvent;
  saved: GpsSavedEvent;
  error: GpsErrorEvent;
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
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

const NativeGpsRecorder = (NativeModules.GpsRecorder as GpsRecorderNativeType) || {
  start: async () => {},
  stop: async () => {},
  isRecording: async () => false,
  getState: async () => ({ isRecording: false, pointCount: 0, elapsedMs: 0, lastFix: null }),
  requestPermissions: async () => false,
  hasPermissions: async () => false,
  requestIgnoreBatteryOptimizations: async () => false,
  openAppSettings: async () => {},
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
