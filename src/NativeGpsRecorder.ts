/**
 * Native GpsRecorder module TypeScript declarations.
 *
 * The actual implementation lives in:
 *   android/app/src/main/java/com/gpsrecorder/GpsRecorderModule.kt
 */

import { NativeModules, NativeEventEmitter, EmitterSubscription } from 'react-native';

export type GpsLocationEvent = {
  lat: number;
  lon: number;
  alt: number | null;
  speed: number | null; // m/s
  accuracy: number | null; // meters
  timestamp: number; // epoch ms
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
  requestPermissions: () => NativeGpsRecorder.requestPermissions(),
  hasPermissions: () => NativeGpsRecorder.hasPermissions(),
  requestIgnoreBatteryOptimizations: () => NativeGpsRecorder.requestIgnoreBatteryOptimizations(),
  openAppSettings: () => NativeGpsRecorder.openAppSettings(),
};

export const GpsRecorderEmitter = new NativeEventEmitter(
  NativeModules.GpsRecorder as unknown as { addListener: (e: string) => void; removeListeners: (n: number) => void }
);

export function subscribe<K extends keyof GpsRecorderEvents>(
  event: K,
  handler: (payload: GpsRecorderEvents[K]) => void
): EmitterSubscription {
  return GpsRecorderEmitter.addListener(event, handler as (p: unknown) => void);
}
