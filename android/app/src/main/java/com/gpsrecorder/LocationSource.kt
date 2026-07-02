package com.gpsrecorder

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.GnssStatus
import android.location.LocationListener
import android.location.LocationManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * O7 / O24 (round 2) — GPS provider + GNSS status tracking extracted from
 * GpsRecorderService.kt.
 *
 * Encapsulates:
 *   - LocationManager acquisition + GPS / network provider selection.
 *   - `requestLocationUpdates` / `removeUpdates` (the [LocationListener] is
 *     passed in by the service — the service still implements it because
 *     `onLocationChanged` is the 470-line heart of the recording pipeline).
 *   - `GnssStatus.Callback` registration for satellite-count tracking.
 *   - [computeFixType] from satellite count + fix recency.
 *
 * L1 invariant preserved: [startLocationUpdates] returns `false` on
 * precondition failure (no LocationManager, no permission, no provider).
 * On `false`, the service's `startRecording` MUST bail out immediately.
 * The actual `stopRecording()` call (which finalizes, releases wakelock,
 * emits state=false, calls stopSelf) is invoked via the [onFatalError]
 * callback so this class has no direct dependency on the service's
 * lifecycle methods.
 *
 * L16 invariant preserved: `computeFixType` requires ≥3 sats for a 2D fix
 * and ≥4 for 3D; 1–2 sats → "no fix".
 */
class LocationSource(
    private val service: GpsRecorderService,
    private val listener: LocationListener,
    private val onFatalError: (String) -> Unit,
    private val onGnssStatusPersist: (satellitesUsed: Int, fixType: String) -> Unit,
) {

    private val tag: String get() = GpsRecorderService.TAG

    private var locationManager: LocationManager? = null
    private var gnssStatusCallback: GnssStatus.Callback? = null

    /** Satellite count used in the most recent fix (0 if no fix yet). */
    @Volatile var satellitesUsed: Int = 0
        private set

    /**
     * Requests location updates from GPS + network providers.
     *
     * Returns `true` on success. Returns `false` on precondition failure —
     * in that case [onFatalError] has ALREADY been invoked (which the
     * service implements as: emit fatal error → call stopRecording →
     * stopSelf). The caller MUST bail out without touching further state.
     *
     * L1 fix (preserved): the previous version kept going after a failed
     * start, leaving the UI showing "recording" on a stopped service and
     * an orphan temp file in externalCacheDir.
     *
     * NOTE: we deliberately do NOT seed from `getLastKnownLocation()` here.
     * That cached fix is frequently stale (30+ s old) and would inflate
     * the distance of a fresh recording — the "starts with 9 m / 69 m" bug.
     * The always-on GNSS monitor in GpsRecorderModule already seeds the UI;
     * the service just waits for the first real fix from
     * `requestLocationUpdates()` above, which is guaranteed to be fresh.
     */
    fun startLocationUpdates(): Boolean {
        if (locationManager == null) {
            locationManager = service.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        }
        val lm = locationManager ?: run {
            Log.e(tag, "No LocationManager")
            onFatalError("Location service unavailable")
            return false
        }

        // Check permissions
        if (ContextCompat.checkSelfPermission(service, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            Log.e(tag, "No FINE_LOCATION permission")
            onFatalError("Location permission not granted")
            return false
        }

        // Prefer GPS provider, fall back to network if needed
        val providers = mutableListOf<String>()
        if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            providers.add(LocationManager.GPS_PROVIDER)
        }
        if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
            providers.add(LocationManager.NETWORK_PROVIDER)
        }
        if (providers.isEmpty()) {
            Log.e(tag, "No location provider enabled")
            onFatalError("No location provider enabled. Please enable location in settings.")
            return false
        }

        for (p in providers) {
            try {
                lm.requestLocationUpdates(
                    p,
                    GpsRecorderService.MIN_TIME_MS,
                    GpsRecorderService.MIN_DISTANCE_M,
                    listener,
                    Looper.getMainLooper(),
                )
                Log.i(tag, "Requested location updates from $p")
            } catch (e: SecurityException) {
                Log.e(tag, "SecurityException requesting updates from $p", e)
            } catch (e: IllegalArgumentException) {
                Log.e(tag, "IllegalArg requesting updates from $p", e)
            }
        }
        return true
    }

    fun stopLocationUpdates() {
        locationManager?.removeUpdates(listener)
    }

    /**
     * Registers a GnssStatus callback to track how many satellites are used
     * in the current fix. Used by [computeFixType] to distinguish 2D vs 3D
     * fixes. The [onGnssStatusPersist] callback is invoked on every status
     * change so the service can persist the values to SharedPreferences
     * (for JS getState() polling).
     */
    fun startGnssStatusTracking() {
        val lm = locationManager ?: return
        if (gnssStatusCallback != null) return  // already registered
        val cb = object : GnssStatus.Callback() {
            override fun onSatelliteStatusChanged(status: GnssStatus) {
                var used = 0
                for (i in 0 until status.satelliteCount) {
                    if (status.usedInFix(i)) used++
                }
                satellitesUsed = used
                try {
                    onGnssStatusPersist(used, computeFixType())
                } catch (e: Exception) {
                    Log.w(tag, "Failed to persist GNSS status", e)
                }
            }

            override fun onStarted() {
                Log.i(tag, "GNSS engine started")
            }

            override fun onStopped() {
                Log.i(tag, "GNSS engine stopped")
                satellitesUsed = 0
            }
        }
        try {
            lm.registerGnssStatusCallback(cb, Handler(Looper.getMainLooper()))
            gnssStatusCallback = cb
            Log.i(tag, "Registered GNSS status callback")
        } catch (e: Exception) {
            Log.w(tag, "registerGnssStatusCallback failed", e)
        }
    }

    fun stopGnssStatusTracking() {
        val cb = gnssStatusCallback ?: return
        try {
            locationManager?.unregisterGnssStatusCallback(cb)
        } catch (e: Exception) {
            Log.w(tag, "unregisterGnssStatusCallback failed", e)
        }
        gnssStatusCallback = null
        satellitesUsed = 0
    }

    /** Resets the satellite count to 0 (called on fresh recording start). */
    fun resetSatellites() {
        satellitesUsed = 0
    }

    /**
     * Determines the GNSS fix type from the satellite count and fix recency:
     *   - "no fix" — no recent fix, or fewer than 3 satellites used in fix
     *   - "2D fix" — exactly 3 satellites used (lat/lon only)
     *   - "3D fix" — 4+ satellites used (lat/lon + altitude)
     *
     * L16 fix (preserved): previously 1–3 satellites were reported as "2D
     * fix", but a real 2D fix requires ≥3 satellites — with 1–2 sats no
     * position solution exists, so the UI should say "no fix".
     */
    fun computeFixType(lastFixTimeMs: Long): String {
        val now = System.currentTimeMillis()
        val recentFix = lastFixTimeMs > 0 && (now - lastFixTimeMs) < GpsRecorderService.NO_FIX_TIMEOUT_MS
        if (!recentFix) return "no fix"
        return when {
            satellitesUsed >= 4 -> "3D fix"
            satellitesUsed == 3 -> "2D fix"
            else -> "no fix"
        }
    }
}
