package com.gpsrecorder

import android.content.Context
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * React Native bridge to GpsRecorderService.
 *
 * Methods exposed to JS:
 *   - start()                      -> starts recording
 *   - stop()                       -> stops and saves GPX file (resolves with {filePath, pointCount})
 *   - isRecording()                -> Promise<Boolean>
 *   - requestPermissions()         -> Promise<Boolean> (location + notifications + battery)
 *   - hasPermissions()             -> Promise<Boolean> (no request, just check)
 *   - requestIgnoreBatteryOptimizations() -> Promise<Boolean>
 *   - openAppSettings()            -> void (fallback when user denies permissions)
 *   - setPostProcessEnabled(b)     -> Promise<Boolean> (on-the-fly track filter)
 *   - getPostProcessEnabled()      -> Promise<Boolean>
 *   - setGaussianSmoothingEnabled(b) -> Promise<Boolean> (post-process Gaussian smoother)
 *   - getGaussianSmoothingEnabled() -> Promise<Boolean>
 *   - setRadialDistanceFilterEnabled(b) -> Promise<Boolean> (on-the-fly radial distance filter)
 *   - getRadialDistanceFilterEnabled()  -> Promise<Boolean>
 *   - setRadialDistanceThresholdM(n)    -> Promise<Int>    (clamp [0,1000])
 *   - getRadialDistanceThresholdM()     -> Promise<Int>
 *   - setTimeSamplingEnabled(b)     -> Promise<Boolean> (on-the-fly keep every N-th fix)
 *   - getTimeSamplingEnabled()      -> Promise<Boolean>
 *   - setTimeSamplingN(n)           -> Promise<Int>    (clamp [1,60])
 *   - getTimeSamplingN()            -> Promise<Int>
 *   - setDouglasPeuckerEnabled(b)   -> Promise<Boolean> (post-process Douglas-Peucker simplifier)
 *   - getDouglasPeuckerEnabled()    -> Promise<Boolean>
 *   - setDouglasPeuckerEpsilonM(d)  -> Promise<Double> (clamp [0,500])
 *   - getDouglasPeuckerEpsilonM()   -> Promise<Double>
 *   - setAutoPauseEnabled(b)       -> Promise<Boolean> (auto-pause on stop detection)
 *   - getAutoPauseEnabled()        -> Promise<Boolean>
 *   - setGapDetectionEnabled(b)    -> Promise<Boolean> (gap detection on signal loss)
 *   - getGapDetectionEnabled()     -> Promise<Boolean>
 *   - setShowMovingTimeEnabled(b)  -> Promise<Boolean> (display: show moving time vs total)
 *   - getShowMovingTimeEnabled()   -> Promise<Boolean>
 *   - startGnssMonitor()           -> Promise<Boolean> (always-on GNSS status)
 *   - stopGnssMonitor()            -> Promise<Boolean>
 *   - addListener(String)          -> required by NativeEventEmitter
 *   - removeListeners(Integer)     -> required by NativeEventEmitter
 *
 * Events emitted to JS (via GpsEventEmitter):
 *   - "location"  { lat, lon, alt, speed, accuracy, fixType, distance, timestamp,
 *                   pointCount, isAutoPaused, signalLost, movingMs }
 *   - "duration"  { elapsedMs }
 *   - "state"     { isRecording, pointCount, elapsedMs, isAutoPaused, signalLost, movingMs }
 *   - "saved"     { filePath, pointCount }
 *   - "error"     { message }
 *   - "gnss"      { fixType, accuracy, satellitesUsed, satellitesInView, hasFix,
 *                   lat, lon, alt, speed, timestamp }
 *
 * Task K8 refactor: the always-on GNSS monitor, event emission layer,
 * permission/battery-optimization helpers, and settings bridge have all
 * been extracted into their own files:
 *   - [GnssMonitor]        — startGnssMonitor / stopGnssMonitor / teardown
 *   - [GpsEventEmitter]    — object singleton: emitLocation / emitDuration /
 *                            emitState / emitSaved / emitError / emitGnssStatus
 *   - [PermissionHelper]   — requestPermissions / hasPermissions /
 *                            requestIgnoreBatteryOptimizations / openAppSettings / teardown
 *   - [SettingsBridge]     — 11 toggle pairs persisted in
 *                            "gps_recorder_settings" SharedPreferences
 *
 * This class keeps the @ReactMethod-annotated wrappers (RN discovers the
 * JS-facing API via reflection on `ReactContextBaseJavaModule` subclasses)
 * and delegates each one to the corresponding helper.
 */
class GpsRecorderModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val gnssMonitor = GnssMonitor(reactContext)
    private val permissionHelper = PermissionHelper(reactContext)
    private val settingsBridge = SettingsBridge(reactContext)

    init {
        // Bind the GpsEventEmitter singleton to this module's
        // ReactApplicationContext so GpsRecorderService /
        // StateRepository / GpxFileSaver can emit events without holding
        // a per-instance module reference. unbind() is called from
        // onCatalystInstanceDestroy().
        GpsEventEmitter.bind(reactContext)
    }

    override fun getName(): String = "GpsRecorder"

    override fun getConstants(): Map<String, Any> = emptyMap()

    // ---- Always-on GNSS monitor (delegated to GnssMonitor) ----

    @ReactMethod
    fun startGnssMonitor(promise: Promise) {
        gnssMonitor.startGnssMonitor(promise)
    }

    @ReactMethod
    fun stopGnssMonitor(promise: Promise) {
        gnssMonitor.stopGnssMonitor(promise)
    }

    // ---- Recording control ----

    @ReactMethod
    fun start(promise: Promise) {
        try {
            if (!permissionHelper.hasFineLocation()) {
                promise.reject("E_PERMISSION", "Location permission not granted")
                return
            }
            val ctx = reactContext
            val intent = Intent(ctx, GpsRecorderService::class.java).apply {
                action = GpsRecorderService.ACTION_START
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("E_START", e.message ?: "Failed to start", e)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        try {
            val ctx = reactContext
            val intent = Intent(ctx, GpsRecorderService::class.java).apply {
                action = GpsRecorderService.ACTION_STOP
            }
            ctx.startService(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("E_STOP", e.message ?: "Failed to stop", e)
        }
    }

    // O17: isRecording() @ReactMethod removed — superseded by getState().isRecording.
    // The JS side already polls getState() for live state, and the native module
    // still exposes `is_recording` via the state event for backward compatibility.

    // ---- Settings @ReactMethods (delegated to SettingsBridge) ----

    @ReactMethod
    fun setPostProcessEnabled(enabled: Boolean, promise: Promise) {
        settingsBridge.setPostProcessEnabled(enabled, promise)
    }

    @ReactMethod
    fun getPostProcessEnabled(promise: Promise) {
        settingsBridge.getPostProcessEnabled(promise)
    }

    @ReactMethod
    fun setGaussianSmoothingEnabled(enabled: Boolean, promise: Promise) {
        settingsBridge.setGaussianSmoothingEnabled(enabled, promise)
    }

    @ReactMethod
    fun getGaussianSmoothingEnabled(promise: Promise) {
        settingsBridge.getGaussianSmoothingEnabled(promise)
    }

    @ReactMethod
    fun setRadialDistanceFilterEnabled(enabled: Boolean, promise: Promise) {
        settingsBridge.setRadialDistanceFilterEnabled(enabled, promise)
    }

    @ReactMethod
    fun getRadialDistanceFilterEnabled(promise: Promise) {
        settingsBridge.getRadialDistanceFilterEnabled(promise)
    }

    @ReactMethod
    fun setRadialDistanceThresholdM(thresholdM: Int, promise: Promise) {
        settingsBridge.setRadialDistanceThresholdM(thresholdM, promise)
    }

    @ReactMethod
    fun getRadialDistanceThresholdM(promise: Promise) {
        settingsBridge.getRadialDistanceThresholdM(promise)
    }

    @ReactMethod
    fun setTimeSamplingEnabled(enabled: Boolean, promise: Promise) {
        settingsBridge.setTimeSamplingEnabled(enabled, promise)
    }

    @ReactMethod
    fun getTimeSamplingEnabled(promise: Promise) {
        settingsBridge.getTimeSamplingEnabled(promise)
    }

    @ReactMethod
    fun setTimeSamplingN(n: Int, promise: Promise) {
        settingsBridge.setTimeSamplingN(n, promise)
    }

    @ReactMethod
    fun getTimeSamplingN(promise: Promise) {
        settingsBridge.getTimeSamplingN(promise)
    }

    @ReactMethod
    fun setDouglasPeuckerEnabled(enabled: Boolean, promise: Promise) {
        settingsBridge.setDouglasPeuckerEnabled(enabled, promise)
    }

    @ReactMethod
    fun getDouglasPeuckerEnabled(promise: Promise) {
        settingsBridge.getDouglasPeuckerEnabled(promise)
    }

    @ReactMethod
    fun setDouglasPeuckerEpsilonM(epsilonM: Double, promise: Promise) {
        settingsBridge.setDouglasPeuckerEpsilonM(epsilonM, promise)
    }

    @ReactMethod
    fun getDouglasPeuckerEpsilonM(promise: Promise) {
        settingsBridge.getDouglasPeuckerEpsilonM(promise)
    }

    @ReactMethod
    fun setAutoPauseEnabled(enabled: Boolean, promise: Promise) {
        settingsBridge.setAutoPauseEnabled(enabled, promise)
    }

    @ReactMethod
    fun getAutoPauseEnabled(promise: Promise) {
        settingsBridge.getAutoPauseEnabled(promise)
    }

    @ReactMethod
    fun setGapDetectionEnabled(enabled: Boolean, promise: Promise) {
        settingsBridge.setGapDetectionEnabled(enabled, promise)
    }

    @ReactMethod
    fun getGapDetectionEnabled(promise: Promise) {
        settingsBridge.getGapDetectionEnabled(promise)
    }

    @ReactMethod
    fun setShowMovingTimeEnabled(enabled: Boolean, promise: Promise) {
        settingsBridge.setShowMovingTimeEnabled(enabled, promise)
    }

    @ReactMethod
    fun getShowMovingTimeEnabled(promise: Promise) {
        settingsBridge.getShowMovingTimeEnabled(promise)
    }

    /**
     * Returns the current recording state, point count, elapsed time, last GPS fix,
     * total distance traveled, and current GNSS fix type. JS calls this on mount and
     * every 2 seconds while recording as a reliable fallback in case the event
     * emitter is not delivering events.
     */
    @ReactMethod
    fun getState(promise: Promise) {
        try {
            val prefs = reactContext.getSharedPreferences("gps_recorder_state", Context.MODE_PRIVATE)
            val isRec = prefs.getBoolean("is_recording", false)
            val startTime = prefs.getLong("start_time_ms", 0L)
            val count = prefs.getInt("point_count", 0)
            val elapsed = if (isRec && startTime > 0) System.currentTimeMillis() - startTime else 0L
            val distance = prefs.getString("total_distance_m", "0")?.toDoubleOrNull() ?: 0.0
            val fixType = prefs.getString("fix_type", "no fix") ?: "no fix"
            // Phase 1/3/4: read auto-pause / signal-lost / moving-time so JS
            // can poll via getState() and stay in sync after a service restart.
            val autoPaused = prefs.getBoolean("is_auto_paused", false)
            val sigLost = prefs.getBoolean("signal_lost", false)
            val movMs = prefs.getLong("moving_ms", 0L)

            val map = Arguments.createMap().apply {
                putBoolean("isRecording", isRec)
                putInt("pointCount", count)
                putDouble("elapsedMs", elapsed.toDouble())
                putDouble("distance", distance)
                putString("fixType", fixType)
                putBoolean("isAutoPaused", autoPaused)
                putBoolean("signalLost", sigLost)
                putDouble("movingMs", movMs.toDouble())

                val lastLat = prefs.getString("last_lat", null)
                val lastLon = prefs.getString("last_lon", null)
                if (lastLat != null && lastLon != null) {
                    val fix = Arguments.createMap().apply {
                        putDouble("lat", lastLat.toDouble())
                        putDouble("lon", lastLon.toDouble())
                        val alt = prefs.getString("last_alt", "")?.takeIf { it.isNotEmpty() }
                        if (alt != null) putDouble("alt", alt.toDouble()) else putNull("alt")
                        val spd = prefs.getString("last_speed", "")?.takeIf { it.isNotEmpty() }
                        if (spd != null) putDouble("speed", spd.toDouble()) else putNull("speed")
                        val acc = prefs.getString("last_accuracy", "")?.takeIf { it.isNotEmpty() }
                        if (acc != null) putDouble("accuracy", acc.toDouble()) else putNull("accuracy")
                        putString("fixType", fixType)
                        putDouble("distance", distance)
                        putDouble("timestamp", prefs.getLong("last_time_ms", 0L).toDouble())
                    }
                    putMap("lastFix", fix)
                } else {
                    putNull("lastFix")
                }
            }
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("E_STATE", e.message ?: "getState error", e)
        }
    }

    // ---- Permissions + battery-optimization (delegated to PermissionHelper) ----

    @ReactMethod
    fun requestPermissions(promise: Promise) {
        permissionHelper.requestPermissions(promise)
    }

    @ReactMethod
    fun hasPermissions(promise: Promise) {
        permissionHelper.hasPermissions(promise)
    }

    @ReactMethod
    fun requestIgnoreBatteryOptimizations(promise: Promise) {
        permissionHelper.requestIgnoreBatteryOptimizations(promise)
    }

    @ReactMethod
    fun openAppSettings(promise: Promise) {
        permissionHelper.openAppSettings(promise)
    }

    // O18: These are required by ReactContextBaseJavaModule's NativeEventEmitter
    // contract, but we emit events via DeviceEventEmitter directly (see
    // GpsEventEmitter.emitLocation/emitState/etc.). The JS side subscribes via
    // DeviceEventEmitter.addListener (see NativeGpsRecorder.ts), so these
    // stubs are never called. Kept as no-ops for API compatibility.
    @ReactMethod
    fun addListener(eventName: String) { /* no-op — see O18 comment above */ }

    @ReactMethod
    fun removeListeners(count: Int) { /* no-op — see O18 comment above */ }

    @Suppress("DEPRECATION")
    override fun onCatalystInstanceDestroy() {
        // L14 fix: unbind the GpsEventEmitter singleton FIRST so the
        // service stops emitting events into a dead ReactApplicationContext.
        // The previous code only tore down the GNSS monitor but left the
        // companion `instance` pointing at this dying module — across a
        // dev reload (Cmd+R in Metro) the old module (and its
        // ReactApplicationContext) leaked, and the service kept calling
        // module.send(...) on a dead module. send() swallowed the
        // exception so there was no crash, but the leak persisted.
        GpsEventEmitter.unbind()
        // Tear down the GNSS monitor (unregister callbacks / listeners,
        // null the LocationManager so a fresh one is created on next
        // startGnssMonitor).
        gnssMonitor.teardown()
        // Resolve any pending permission / battery promise so JS doesn't
        // hang waiting for a callback that will never fire (L9 / L23 fixes).
        permissionHelper.teardown()
        super.onCatalystInstanceDestroy()
    }
}
