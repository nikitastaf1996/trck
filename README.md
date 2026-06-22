# GPS Recorder

A small **React Native** Android app that records GPS tracks in the background
and saves them as `.gpx` files to the public `Downloads/GpsRecorder/` folder.

> The APK is committed in [`apk/GpsRecorder-release.apk`](./apk/GpsRecorder-release.apk)
> because the developer's PC is down and they cannot build it themselves.
> See [`AGENTS.md`](./AGENTS.md) for the full explanation and the rebuild workflow.

## Features

- Big **Start / Stop** button.
- Duration of recording, ticking every second.
- Persistent **foreground-service notification** with a **Stop** action — you
  can stop the recording without ever opening the app again.
- GPS fixes saved as a GPX 1.1 file under `Downloads/GpsRecorder/`.
- Recording survives the app being backgrounded, swiped away from recents,
  the screen turning off, and (best-effort) the system killing the process.

## How to install

1. Download `apk/GpsRecorder-release.apk` from this repo.
2. On your Android phone, open the file (e.g. from the Files app or a browser
   download notification).
3. Allow "install from unknown sources" if prompted.
4. Open the app, grant the location and notification permissions, and tap
   **START**.

GPX files will appear under `Downloads/GpsRecorder/`.

## How to build (for agents / future me)

See [`AGENTS.md`](./AGENTS.md) for the full workflow. The short version:

```bash
npm install
cd android
./gradlew assembleRelease
# -> android/app/build/outputs/apk/release/app-release.apk
```

## Tech stack

- React Native 0.86
- Hermes JS engine
- Kotlin (Android side)
- Android `LocationManager` (no Google Play Services dependency)
- Foreground service + `WakeLock` + `START_STICKY` for stability
- `MediaStore.Downloads` for writing GPX files to the public Downloads folder
  (Android 10+), with a legacy `Environment.DIRECTORY_DOWNLOADS` fallback for
  older versions.
