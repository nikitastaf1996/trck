package com.gpsrecorder

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext

/**
 * Always-on GNSS monitor extracted from `GpsRecorderModule` (Task K8).
 *
 * Lightweight location + GnssStatus listener that runs whenever the JS app is
 * alive and permissions are granted. It emits 'gnss' events so the UI can show
 * the current fix type / accuracy / satellite count BEFORE the user starts
 * recording. The monitor does NOT write to the GPX buffer or affect recording.
 *
 * When recording starts, the service's own LocationListener takes over; we
 * keep the monitor running too because it's harmless and the user might stop
 * recording and want to see the status again.
 *
 * The two JS-facing methods (`startGnssMonitor`, `stopGnssMonitor`) are
 * delegated to from `GpsRecorderModule`'s @ReactMethod-annotated wrappers.
 * `teardown()` is called from `GpsRecorderModule.onCatalystInstanceDestroy()`.
 *
 * The monitor emits via `GpsEventEmitter.emitGnssStatus(...)` so the
 * singleton owns the `RCTDeviceEventEmitter` plumbing.
 */
class GnssMonitor(private val reactContext: ReactApplicationContext) {

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

    // L27 fix: cached last-emitted GnssState so the heartbeat can skip
    // redundant emits when nothing has changed. The cache is reset to
    // null on startGnssMonitor() (so the first emit is always sent) and
    // cleared on stopGnssMonitor().
    @Volatile private var lastEmittedFixType: String? = null
    @Volatile private var lastEmittedAccuracy: Float? = null
    @Volatile private var lastEmittedSatellitesUsed: Int = -1
    @Volatile private var lastEmittedSatellitesInView: Int = -1
    @Volatile private var lastEmittedHasFix: Boolean? = null
    @Volatile private var lastEmittedLat: Double? = null
    @Volatile private var lastEmittedLon: Double? = null
    @Volatile private var lastEmittedAlt: Double? = null
    @Volatile private var lastEmittedSpeed: Float? = null
    @Volatile private var monitorFirstEmitPending: Boolean = false

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
        // L16 fix: a real 2D fix requires ≥3 satellites — with 1–2 sats no
        // position solution exists, so the UI should say "no fix".
        return when {
            monitorSatellitesUsed >= 4 -> "3D fix"
            monitorSatellitesUsed == 3 -> "2D fix"
            else -> "no fix"
        }
    }

    /**
     * L27 fix: emits the current GNSS state to JS, but ONLY if it has
     * changed since the last emit (or if [force] is true). Called by the
     * heartbeat every 3 s and by the location / GnssStatus callbacks.
     *
     * - On startGnssMonitor(): set monitorFirstEmitPending = true so the
     *   first emit is always sent (the cache is empty anyway, but this is
     *   a belt-and-braces guard).
     * - On stopGnssMonitor(): call emitGnssFromMonitor(force = true) before
     *   tearing down so the last state is sent.
     */
    private fun emitGnssFromMonitor(force: Boolean = false) {
        val fixType = computeMonitorFixType()
        val hasFix = fixType != "no fix"
        val acc = monitorLastAccuracy
        val sUsed = monitorSatellitesUsed
        val sView = monitorSatellitesInView
        val lat = monitorLastLat
        val lon = monitorLastLon
        val alt = monitorLastAlt
        val spd = monitorLastSpeed

        if (!force && !monitorFirstEmitPending &&
            fixType == lastEmittedFixType &&
            acc == lastEmittedAccuracy &&
            sUsed == lastEmittedSatellitesUsed &&
            sView == lastEmittedSatellitesInView &&
            hasFix == lastEmittedHasFix &&
            lat == lastEmittedLat &&
            lon == lastEmittedLon &&
            alt == lastEmittedAlt &&
            spd == lastEmittedSpeed
        ) {
            // L27 fix: state unchanged — skip the emit. This eliminates ~20
            // redundant JS events per minute when the GNSS state is stable.
            return
        }

        GpsEventEmitter.emitGnssStatus(
            fixType = fixType,
            accuracy = acc,
            satellitesUsed = sUsed,
            satellitesInView = sView,
            hasFix = hasFix,
            lat = lat,
            lon = lon,
            altitude = alt,
            speed = spd
        )

        // Update the cache.
        lastEmittedFixType = fixType
        lastEmittedAccuracy = acc
        lastEmittedSatellitesUsed = sUsed
        lastEmittedSatellitesInView = sView
        lastEmittedHasFix = hasFix
        lastEmittedLat = lat
        lastEmittedLon = lon
        lastEmittedAlt = alt
        lastEmittedSpeed = spd
        monitorFirstEmitPending = false
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

    /**
     * JS-facing (via GpsRecorderModule.startGnssMonitor delegation).
     * Starts the always-on GNSS monitor: registers a GnssStatus.Callback
     * for satellite counts and a LocationListener on GPS_PROVIDER for
     * frequent fixes (2 s, 0 m). Resolves with `true` on success.
     */
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
            // L27 fix: force the first emit after start so the UI gets an
            // immediate state update even if no satellites have changed.
            monitorFirstEmitPending = true
            monitorHandler.post(monitorHeartbeat)
            Log.i(TAG, "GNSS monitor started")
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("E_MONITOR", e.message ?: "monitor start error", e)
        }
    }

    /**
     * JS-facing (via GpsRecorderModule.stopGnssMonitor delegation).
     * Forces a final emit, unregisters all callbacks / listeners, clears
     * the L27 dedup cache, and resolves with `true`.
     */
    fun stopGnssMonitor(promise: Promise) {
        try {
            if (!monitorRunning) {
                promise.resolve(true); return
            }
            // L27 fix: force a final emit before tearing down so the JS
            // side gets the last known state.
            emitGnssFromMonitor(force = true)
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
            // L27 fix: clear the cache so the next startGnssMonitor() will
            // always emit at least once.
            lastEmittedFixType = null
            lastEmittedAccuracy = null
            lastEmittedSatellitesUsed = -1
            lastEmittedSatellitesInView = -1
            lastEmittedHasFix = null
            lastEmittedLat = null
            lastEmittedLon = null
            lastEmittedAlt = null
            lastEmittedSpeed = null
            monitorFirstEmitPending = false
            Log.i(TAG, "GNSS monitor stopped")
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("E_MONITOR", e.message ?: "monitor stop error", e)
        }
    }

    /**
     * Called from `GpsRecorderModule.onCatalystInstanceDestroy()` to tear
     * down the monitor across a dev reload (Cmd+R in Metro) so the old
     * monitor doesn't leak. Nulls `monitorLocationManager` so a fresh one
     * is created on the next `startGnssMonitor`.
     */
    fun teardown() {
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
            monitorLocationManager = null
        } catch (e: Exception) {
            Log.w(TAG, "GnssMonitor teardown failed", e)
        }
    }

    // ---- Internal helpers ----

    private fun hasFineLocation(): Boolean =
        ContextCompat.checkSelfPermission(reactContext, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private companion object {
        private const val TAG = "GnssMonitor"
    }
}
