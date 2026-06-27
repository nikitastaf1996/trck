package com.gpsrecorder

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

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
 *   - setAutoPauseEnabled(b)       -> Promise<Boolean> (auto-pause on stop detection)
 *   - getAutoPauseEnabled()        -> Promise<Boolean>
 *   - setGapDetectionEnabled(b)    -> Promise<Boolean> (gap detection on signal loss)
 *   - getGapDetectionEnabled()     -> Promise<Boolean>
 *   - startGnssMonitor()           -> Promise<Boolean> (always-on GNSS status)
 *   - stopGnssMonitor()            -> Promise<Boolean>
 *   - addListener(String)          -> required by NativeEventEmitter
 *   - removeListeners(Integer)     -> required by NativeEventEmitter
 *
 * Events emitted to JS:
 *   - "location"  { lat, lon, alt, speed, accuracy, fixType, distance, timestamp,
 *                   pointCount, isAutoPaused, signalLost, movingMs }
 *   - "duration"  { elapsedMs }
 *   - "state"     { isRecording, pointCount, elapsedMs, isAutoPaused, signalLost, movingMs }
 *   - "saved"     { filePath, pointCount }
 *   - "error"     { message }
 *   - "gnss"      { fixType, accuracy, satellitesUsed, satellitesInView, hasFix,
 *                   lat, lon, alt, speed, timestamp }
 */
class GpsRecorderModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "GpsRecorderModule"
        // Singleton reference so the Service can emit events without depending on JS being alive.
        @Volatile private var instance: GpsRecorderModule? = null

        // ---- Event emitters called from GpsRecorderService ----
        fun emitLocation(
            lat: Double, lon: Double, alt: Double?, speed: Float?, accuracy: Float?,
            fixType: String, distanceMeters: Double,
            timestamp: Long, pointCount: Int,
            isAutoPaused: Boolean = false,
            signalLost: Boolean = false,
            movingMs: Long = 0L
        ) {
            val module = instance ?: return
            val map = Arguments.createMap().apply {
                putDouble("lat", lat)
                putDouble("lon", lon)
                if (alt != null) putDouble("alt", alt) else putNull("alt")
                if (speed != null) putDouble("speed", speed.toDouble()) else putNull("speed")
                if (accuracy != null) putDouble("accuracy", accuracy.toDouble()) else putNull("accuracy")
                putString("fixType", fixType)
                putDouble("distance", distanceMeters)
                putDouble("timestamp", timestamp.toDouble())
                putInt("pointCount", pointCount)
                // Phase 1/3/4: auto-pause / signal-lost / moving-time so the
                // JS UI can reflect pause / gap status in real time.
                putBoolean("isAutoPaused", isAutoPaused)
                putBoolean("signalLost", signalLost)
                putDouble("movingMs", movingMs.toDouble())
            }
            module.send("location", map)
        }

        fun emitDuration(elapsedMs: Long) {
            val module = instance ?: return
            val map = Arguments.createMap().apply {
                putDouble("elapsedMs", elapsedMs.toDouble())
            }
            module.send("duration", map)
        }

        fun emitState(
            isRecording: Boolean,
            pointCount: Int,
            elapsedMs: Long,
            isAutoPaused: Boolean = false,
            signalLost: Boolean = false,
            movingMs: Long = 0L
        ) {
            val module = instance ?: return
            val map = Arguments.createMap().apply {
                putBoolean("isRecording", isRecording)
                putInt("pointCount", pointCount)
                putDouble("elapsedMs", elapsedMs.toDouble())
                // Phase 1/3/4: include auto-pause / signal-lost / moving-time
                // so JS can poll via getState() and stay in sync after a
                // service restart.
                putBoolean("isAutoPaused", isAutoPaused)
                putBoolean("signalLost", signalLost)
                putDouble("movingMs", movingMs.toDouble())
            }
            module.send("state", map)
        }

        fun emitSaved(filePath: String, pointCount: Int, finalDistanceM: Double = -1.0) {
            val module = instance ?: return
            val map = Arguments.createMap().apply {
                putString("filePath", filePath)
                putInt("pointCount", pointCount)
                // Final distance (meters) computed from the SAVED GPX file,
                // post-smoothing. Negative / -1 means "not available; keep
                // the live-accumulated distance". When Gaussian smoothing is
                // applied the smoothed track's length can differ from the
                // raw live-accumulated distance by a few percent, so we send
                // the post-save distance to keep the UI in sync with what
                // the user will see when they import the GPX elsewhere.
                putDouble("finalDistanceM", finalDistanceM)
            }
            module.send("saved", map)
        }

        fun emitError(message: String) {
            val module = instance ?: return
            val map = Arguments.createMap().apply { putString("message", message) }
            module.send("error", map)
        }

        /**
         * Emits a 'gnss' event with the current live GNSS status (independent of
         * recording). Called by the always-on monitor in [GpsRecorderModule].
         */
        fun emitGnssStatus(
            fixType: String,
            accuracy: Float?,
            satellitesUsed: Int,
            satellitesInView: Int,
            hasFix: Boolean,
            lat: Double?,
            lon: Double?,
            altitude: Double?,
            speed: Float?
        ) {
            val module = instance ?: return
            val map = Arguments.createMap().apply {
                putString("fixType", fixType)
                if (accuracy != null) putDouble("accuracy", accuracy.toDouble()) else putNull("accuracy")
                putInt("satellitesUsed", satellitesUsed)
                putInt("satellitesInView", satellitesInView)
                putBoolean("hasFix", hasFix)
                if (lat != null) putDouble("lat", lat) else putNull("lat")
                if (lon != null) putDouble("lon", lon) else putNull("lon")
                if (altitude != null) putDouble("alt", altitude) else putNull("alt")
                if (speed != null) putDouble("speed", speed.toDouble()) else putNull("speed")
                putDouble("timestamp", System.currentTimeMillis().toDouble())
            }
            module.send("gnss", map)
        }
    }

    init { instance = this }

    override fun getName(): String = "GpsRecorder"

    override fun getConstants(): Map<String, Any> = emptyMap()

    // ---- Always-on GNSS monitor (independent of recording) ----
    //
    // Lightweight location + GnssStatus listener that runs whenever the JS app is
    // alive and permissions are granted. It emits 'gnss' events so the UI can show
    // the current fix type / accuracy / satellite count BEFORE the user starts
    // recording. The monitor does NOT write to the GPX buffer or affect recording.
    //
    // When recording starts, the service's own LocationListener takes over; we
    // keep the monitor running too because it's harmless and the user might stop
    // recording and want to see the status again.

    private var monitorLocationManager: LocationManager? = null
    private var monitorGnssCallback: GnssStatus.Callback? = null
    @Volatile private var monitorSatellitesUsed: Int = 0
    @Volatile private var monitorSatellitesInView: Int = 0
    @Volatile private var monitorLastFixTimeMs: Long = 0L
    @Volatile private var monitorLastAccuracy: Float? = null
    @Volatile private var monitorLastLat: Double? = null
    @Volatile private var monitorLastLon: Double? = null
    @Volatile private var monitorLastAlt: Double? = null
    @Volatile private var monitorLastSpeed: Float? = null
    @Volatile private var monitorRunning: Boolean = false
    private val monitorHandler = Handler(Looper.getMainLooper())

    private val monitorLocationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            monitorLastFixTimeMs = if (location.time > 0) location.time else System.currentTimeMillis()
            monitorLastAccuracy = if (location.hasAccuracy()) location.accuracy else null
            monitorLastLat = location.latitude
            monitorLastLon = location.longitude
            monitorLastAlt = if (location.hasAltitude()) location.altitude else null
            monitorLastSpeed = if (location.hasSpeed()) location.speed else null
            emitGnssFromMonitor()
        }
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
        @Deprecated("legacy")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    }

    private fun computeMonitorFixType(): String {
        val now = System.currentTimeMillis()
        val recentFix = monitorLastFixTimeMs > 0 && (now - monitorLastFixTimeMs) < 10_000L
        if (!recentFix) return "no fix"
        if (monitorSatellitesUsed == 0) return "no fix"
        return if (monitorSatellitesUsed >= 4) "3D fix" else "2D fix"
    }

    private fun emitGnssFromMonitor() {
        val fixType = computeMonitorFixType()
        val hasFix = fixType != "no fix"
        emitGnssStatus(
            fixType = fixType,
            accuracy = monitorLastAccuracy,
            satellitesUsed = monitorSatellitesUsed,
            satellitesInView = monitorSatellitesInView,
            hasFix = hasFix,
            lat = monitorLastLat,
            lon = monitorLastLon,
            altitude = monitorLastAlt,
            speed = monitorLastSpeed
        )
    }

    /**
     * Heartbeat runnable: even if no new location arrives, we re-emit the GNSS
     * status every few seconds so the UI can age out a stale fix to "no fix"
     * when the user is indoors and the GPS hasn't produced a fix in 10+ seconds.
     */
    private val monitorHeartbeat = object : Runnable {
        override fun run() {
            if (monitorRunning) {
                emitGnssFromMonitor()
                monitorHandler.postDelayed(this, 3000L)
            }
        }
    }

    @ReactMethod
    fun startGnssMonitor(promise: Promise) {
        try {
            if (monitorRunning) {
                promise.resolve(true); return
            }
            if (!hasFineLocation()) {
                promise.reject("E_PERMISSION", "Location permission not granted")
                return
            }
            val lm = monitorLocationManager ?: run {
                val l = reactContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
                monitorLocationManager = l
                l
            }
            // Register GnssStatus callback for satellite counts
            val cb = object : GnssStatus.Callback() {
                override fun onSatelliteStatusChanged(status: GnssStatus) {
                    var used = 0
                    val total = status.satelliteCount
                    for (i in 0 until total) {
                        if (status.usedInFix(i)) used++
                    }
                    monitorSatellitesUsed = used
                    monitorSatellitesInView = total
                    emitGnssFromMonitor()
                }
                override fun onStarted() { Log.i(TAG, "Monitor: GNSS engine started") }
                override fun onStopped() {
                    Log.i(TAG, "Monitor: GNSS engine stopped")
                    monitorSatellitesUsed = 0
                    monitorSatellitesInView = 0
                    emitGnssFromMonitor()
                }
            }
            try {
                lm.registerGnssStatusCallback(cb, monitorHandler)
                monitorGnssCallback = cb
            } catch (e: Exception) {
                Log.w(TAG, "Monitor: registerGnssStatusCallback failed", e)
            }
            // Register location listener on GPS provider (2s, 0m so we get frequent updates)
            try {
                if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                    lm.requestLocationUpdates(
                        LocationManager.GPS_PROVIDER,
                        2000L, 0.0f,
                        monitorLocationListener,
                        Looper.getMainLooper()
                    )
                }
            } catch (e: SecurityException) {
                Log.w(TAG, "Monitor: SecurityException on requestLocationUpdates", e)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "Monitor: IllegalArgument on requestLocationUpdates", e)
            }
            // Try to seed with last known location so UI shows something immediately
            try {
                val last = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                if (last != null) monitorLocationListener.onLocationChanged(last)
            } catch (e: SecurityException) {
                // ignore
            }
            monitorRunning = true
            monitorHandler.post(monitorHeartbeat)
            Log.i(TAG, "GNSS monitor started")
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("E_MONITOR", e.message ?: "monitor start error", e)
        }
    }

    @ReactMethod
    fun stopGnssMonitor(promise: Promise) {
        try {
            if (!monitorRunning) {
                promise.resolve(true); return
            }
            monitorRunning = false
            monitorHandler.removeCallbacks(monitorHeartbeat)
            try {
                monitorLocationManager?.removeUpdates(monitorLocationListener)
            } catch (e: Exception) {
                Log.w(TAG, "Monitor: removeUpdates failed", e)
            }
            val cb = monitorGnssCallback
            if (cb != null) {
                try {
                    monitorLocationManager?.unregisterGnssStatusCallback(cb)
                } catch (e: Exception) {
                    Log.w(TAG, "Monitor: unregisterGnssStatusCallback failed", e)
                }
                monitorGnssCallback = null
            }
            Log.i(TAG, "GNSS monitor stopped")
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("E_MONITOR", e.message ?: "monitor stop error", e)
        }
    }

    // ---- JS-callable methods ----

    @ReactMethod
    fun start(promise: Promise) {
        try {
            if (!hasFineLocation()) {
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

    @ReactMethod
    fun isRecording(promise: Promise) {
        val prefs = reactContext.getSharedPreferences("gps_recorder_state", Context.MODE_PRIVATE)
        promise.resolve(prefs.getBoolean("is_recording", false))
    }

    // ---- Post-processing setting ----
    //
    // Persisted in a SEPARATE SharedPreferences file ("gps_recorder_settings") so it
    // survives the recording-state clear that happens on stopRecording(). When enabled,
    // GpsRecorderService.finalizeGpxFile() will, after writing the raw GPX file, read
    // it back, apply the post-processing algorithm (sort/dedupe/jump-sweep/interpolate),
    // and overwrite the file with the processed content. When disabled, only raw data
    // is written (the original behavior).

    private fun settingsPrefs() =
        reactContext.getSharedPreferences("gps_recorder_settings", Context.MODE_PRIVATE)

    @ReactMethod
    fun setPostProcessEnabled(enabled: Boolean, promise: Promise) {
        try {
            settingsPrefs().edit().putBoolean("post_process_enabled", enabled).apply()
            Log.i(TAG, "Post-process enabled = $enabled")
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setPostProcessEnabled error", e)
        }
    }

    @ReactMethod
    fun getPostProcessEnabled(promise: Promise) {
        try {
            promise.resolve(settingsPrefs().getBoolean("post_process_enabled", false))
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getPostProcessEnabled error", e)
        }
    }

    // ---- Gaussian-smoothing setting ----
    //
    // Persisted in the same SEPARATE SharedPreferences file ("gps_recorder_settings")
    // as post_process_enabled, so it survives the per-recording state clear. When
    // enabled, GpsRecorderService.finalizeGpxFile() will — after writing the raw /
    // on-the-fly-filtered GPX file — read it back, apply a Gaussian kernel smoother
    // to the lat/lon coordinates, and overwrite the file with the smoothed track.

    @ReactMethod
    fun setGaussianSmoothingEnabled(enabled: Boolean, promise: Promise) {
        try {
            settingsPrefs().edit().putBoolean("gaussian_smoothing_enabled", enabled).apply()
            Log.i(TAG, "Gaussian smoothing enabled = $enabled")
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setGaussianSmoothingEnabled error", e)
        }
    }

    @ReactMethod
    fun getGaussianSmoothingEnabled(promise: Promise) {
        try {
            promise.resolve(settingsPrefs().getBoolean("gaussian_smoothing_enabled", false))
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getGaussianSmoothingEnabled error", e)
        }
    }

    // ---- Auto-pause setting (Phase 1) ----
    //
    // Persisted in the same SEPARATE SharedPreferences file ("gps_recorder_settings")
    // as post_process_enabled / gaussian_smoothing_enabled, so it survives the
    // per-recording state clear. When enabled, GpsRecorderService runs a stop-
    // detection algorithm (sliding 10 s window + speed < 0.35 m/s + max
    // displacement < 3.5 m) that auto-pauses recording while the user is
    // standing still, and auto-resumes when they start moving again.

    @ReactMethod
    fun setAutoPauseEnabled(enabled: Boolean, promise: Promise) {
        try {
            settingsPrefs().edit().putBoolean("auto_pause_enabled", enabled).apply()
            Log.i(TAG, "Auto-pause enabled = $enabled")
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setAutoPauseEnabled error", e)
        }
    }

    @ReactMethod
    fun getAutoPauseEnabled(promise: Promise) {
        try {
            promise.resolve(settingsPrefs().getBoolean("auto_pause_enabled", false))
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getAutoPauseEnabled error", e)
        }
    }

    // ---- Gap-detection setting (Phase 4 toggle) ----
    //
    // Persisted in the same SEPARATE SharedPreferences file
    // ("gps_recorder_settings") as the other toggles, so it survives the
    // per-recording state clear. When enabled (DEFAULT — preserves the
    // behaviour shipped in the previous APK), the gap watchdog in
    // GpsRecorderService.flushTick declares signalLost after
    // GAP_THRESHOLD_MS (15 s) without a fix, and the next arriving fix
    // triggers a segment split so the track has clean <trkseg> breaks at
    // signal outages. When disabled, gaps are NOT detected: the timer
    // keeps running across the outage, the next fix is appended to the
    // same segment, and the velocity gate will compare it against the
    // pre-gap point — the legacy pre-Phase-4 behaviour.

    @ReactMethod
    fun setGapDetectionEnabled(enabled: Boolean, promise: Promise) {
        try {
            settingsPrefs().edit().putBoolean("gap_detection_enabled", enabled).apply()
            Log.i(TAG, "Gap detection enabled = $enabled")
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setGapDetectionEnabled error", e)
        }
    }

    @ReactMethod
    fun getGapDetectionEnabled(promise: Promise) {
        try {
            // Default true: the previous APK always ran gap detection, so
            // existing users get the same behaviour after upgrading.
            promise.resolve(settingsPrefs().getBoolean("gap_detection_enabled", true))
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getGapDetectionEnabled error", e)
        }
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

    @ReactMethod
    fun requestPermissions(promise: Promise) {
        try {
            if (hasAllPermissions()) {
                promise.resolve(true)
                return
            }
            val activity = reactContext.currentActivity as? MainActivity
            if (activity != null) {
                activity.requestAllPermissionsFromJs()
            } else {
                // Activity not yet attached (e.g. JS mounted before MainActivity resumed).
                // Retry shortly on the main thread.
                Handler(Looper.getMainLooper()).postDelayed({
                    try {
                        (reactContext.currentActivity as? MainActivity)?.requestAllPermissionsFromJs()
                    } catch (e: Exception) {
                        android.util.Log.w(TAG, "Deferred permission request failed", e)
                    }
                }, 500L)
            }
            // Return the current state — JS will poll hasPermissions() separately
            // to detect when the user has actually granted the permissions.
            promise.resolve(hasAllPermissions())
        } catch (e: Exception) {
            promise.reject("E_PERM", e.message ?: "Permission error", e)
        }
    }

    @ReactMethod
    fun hasPermissions(promise: Promise) {
        promise.resolve(hasAllPermissions())
    }

    @ReactMethod
    fun requestIgnoreBatteryOptimizations(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                promise.resolve(true); return
            }
            val pm = reactContext.getSystemService(Context.POWER_SERVICE) as PowerManager
            val pkg = reactContext.packageName
            if (pm.isIgnoringBatteryOptimizations(pkg)) {
                promise.resolve(true); return
            }
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$pkg")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            reactContext.startActivity(intent)
            promise.resolve(pm.isIgnoringBatteryOptimizations(pkg))
        } catch (e: Exception) {
            promise.reject("E_BATTERY", e.message ?: "battery opt error", e)
        }
    }

    @ReactMethod
    fun openAppSettings(promise: Promise) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.fromParts("package", reactContext.packageName, null)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            reactContext.startActivity(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "settings error", e)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) { /* required by NativeEventEmitter, no-op */ }

    @ReactMethod
    fun removeListeners(count: Int) { /* required by NativeEventEmitter, no-op */ }

    @Suppress("DEPRECATION")
    override fun onCatalystInstanceDestroy() {
        // Stop the monitor when the RN instance is torn down
        try {
            if (monitorRunning) {
                monitorRunning = false
                monitorHandler.removeCallbacks(monitorHeartbeat)
                monitorLocationManager?.removeUpdates(monitorLocationListener)
                monitorGnssCallback?.let { cb ->
                    monitorLocationManager?.unregisterGnssStatusCallback(cb)
                }
                monitorGnssCallback = null
            }
        } catch (e: Exception) {
            Log.w(TAG, "onCatalystInstanceDestroy cleanup failed", e)
        }
        super.onCatalystInstanceDestroy()
    }

    // ---- Internal helpers ----

    private fun hasFineLocation(): Boolean =
        ContextCompat.checkSelfPermission(reactContext, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun hasNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            reactContext, Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasAllPermissions(): Boolean = hasFineLocation() && hasNotificationPermission()

    private fun send(eventName: String, params: WritableMap) {
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        } catch (e: Exception) {
            // JS app may not be alive; that's fine.
        }
    }
}
