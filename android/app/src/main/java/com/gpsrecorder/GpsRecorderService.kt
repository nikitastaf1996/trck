package com.gpsrecorder

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.MediaStore
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * GpsRecorderService
 *
 * Foreground service that records GPS locations in the background and writes a GPX
 * file to the public Downloads folder when recording stops.
 *
 * Stability features:
 *  - Foreground service with persistent notification -> Android treats it as user-visible
 *    and is very reluctant to kill it.
 *  - START_STICKY -> if the system does kill the service, it will be restarted with a null
 *    intent; we recover state from SharedPreferences and the on-disk temp file.
 *  - Wakelock (PARTIAL_WAKE_LOCK) -> CPU stays awake so we keep getting GPS fixes even
 *    when the screen is off.
 *  - Periodic flush of in-memory points to a temp file -> if the process dies (OOM, crash,
 *    user force stop), we still have the partial GPX file on disk.
 *  - onTaskRemoved -> we do NOT stop the service when the user swipes the task away; the
 *    recording keeps running and the user can stop it from the notification.
 *  - The service does NOT depend on the JS app being alive. It can run, stop, and save the
 *    file entirely on its own.
 */
class GpsRecorderService : Service(), LocationListener {

    companion object {
        private const val TAG = "GpsRecorderService"

        const val ACTION_START = "com.gpsrecorder.action.START"
        const val ACTION_STOP = "com.gpsrecorder.action.STOP"
        const val ACTION_NOTIFICATION_STOP = "com.gpsrecorder.action.NOTIF_STOP"

        const val NOTIFICATION_ID = 0xC0DE
        const val CHANNEL_ID = "gps_recorder_channel"

        // SharedPreferences keys for crash/restart recovery + live state queries
        private const val PREFS_NAME = "gps_recorder_state"
        private const val KEY_IS_RECORDING = "is_recording"
        private const val KEY_START_TIME = "start_time_ms"
        private const val KEY_POINT_COUNT = "point_count"
        private const val KEY_TEMP_FILE_NAME = "temp_file_name"
        private const val KEY_TOTAL_DISTANCE = "total_distance_m"
        private const val KEY_FIX_TYPE = "fix_type"
        private const val KEY_SATELLITES_USED = "satellites_used"
        // Last fix (updated on every GPS callback so JS can poll via getState())
        private const val KEY_LAST_LAT = "last_lat"
        private const val KEY_LAST_LON = "last_lon"
        private const val KEY_LAST_ALT = "last_alt"
        private const val KEY_LAST_SPEED = "last_speed"
        private const val KEY_LAST_ACCURACY = "last_accuracy"
        private const val KEY_LAST_TIME_MS = "last_time_ms"

        // GPS request parameters
        private const val MIN_TIME_MS = 1000L          // 1 second
        private const val MIN_DISTANCE_M = 1.0f         // 1 meter

        // How often we flush points to disk (for crash recovery)
        private const val FLUSH_INTERVAL_MS = 5000L

        // If no GPS fix for this long, treat GNSS status as "no fix"
        private const val NO_FIX_TIMEOUT_MS = 10_000L

        // Accuracy gate (on-the-fly + raw-recording distance accumulator):
        // any fix whose reported horizontal accuracy is worse than this is dropped
        // before it can touch the buffer or the distance accumulator. Tightened
        // from 50 m to 25 m per the user's request — 25 m is still permissive
        // enough for cold-start fixes but filters out the worst multipath noise.
        private const val ACCURACY_THRESHOLD_M = 25.0f

        // Maximum acceptable age of a GPS fix (ms). Fixes older than this are dropped
        // in onLocationChanged to prevent stale cached fixes from inflating the
        // distance of a fresh recording. See "starts with 9 m / 69 m" bug fix.
        private const val MAX_FIX_AGE_MS = 3000L

        // ---- Velocity-based filter (replaces the old 1 km static jump gate) ----
        //
        // Instead of a single "drop the step if it exceeds 1 km" threshold, we now
        // compute the instantaneous velocity between the previous accepted fix and
        // the candidate fix:
        //
        //     velocity = distance(prev, curr) / (t_curr - t_prev)
        //
        // and discard the candidate if that velocity exceeds a mode-of-transport
        // ceiling. For walking / running the ceiling is 20 km/h = 5.5556 m/s — a
        // generous upper bound that covers sprinting uphill with phone bounce but
        // still rejects the classic GPS glitches (teleport 200 m in 1 s = 720 km/h)
        // that a 1 km static gate would only catch when the glitch was already
        // ridiculously large.
        //
        // Duplicate-timestamp fixes (dt == 0) are dropped because they would imply
        // infinite velocity.
        private const val MAX_VELOCITY_MPS = 5.5556f   // 20 km/h walking/running ceiling

        // ---- Gaussian smoothing (post-processing) ----
        // Half-window size: each output point is a weighted average of the input
        // points within ±GAUSSIAN_HALF_WINDOW of it. ±5 points at 1 Hz covers a
        // ~11 s window, which is large enough to suppress single-fix glitches but
        // small enough not to round off real corners.
        private const val GAUSSIAN_HALF_WINDOW = 5
        // Gaussian sigma (in points, not seconds) — controls how flat the kernel
        // is. With sigma=1.5 and a ±5 window, the weights drop to ~1% of the peak
        // at the edges, so the window edges contribute negligibly.
        private const val GAUSSIAN_SIGMA = 1.5

        // ---- Legacy post-processing algorithm thresholds ----
        // (kept as constants so they're easy to tune; documented in postProcessGpx)
        private const val POST_PROCESS_ACCURACY_THRESHOLD_M = 15.0f
        private const val POST_PROCESS_JUMP_THRESHOLD_M = 15.0
        private const val POST_PROCESS_GAP_THRESHOLD_S = 5.0
    }

    private var locationManager: LocationManager? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var handler: Handler = Handler(Looper.getMainLooper())

    // Recording state (persisted to SharedPreferences for recovery)
    @Volatile private var isRecording = false
    private var startTimeMs: Long = 0L
    private var pointCount: Int = 0
    private var tempFileName: String? = null

    // Distance accumulator (meters). Persisted so it survives service restarts.
    @Volatile private var totalDistanceM: Double = 0.0

    // GNSS status tracking (satellites used in current fix).
    @Volatile private var satellitesUsed: Int = 0
    @Volatile private var lastFixTimeMs: Long = 0L
    private var gnssStatusCallback: GnssStatus.Callback? = null

    // Previous point used for distance accumulation + velocity-based filtering
    // (Haversine distance and dt between consecutive accepted fixes).
    @Volatile private var prevLat: Double? = null
    @Volatile private var prevLon: Double? = null
    @Volatile private var prevTimeMs: Long? = null

    // In-memory buffer of GPX points; also persisted to temp file periodically
    private val pointBuffer = ArrayList<GpsPoint>(1024)
    private val pointBufferLock = Any()

    // Duration tick runnable
    private val durationTick = object : Runnable {
        override fun run() {
            if (isRecording) {
                val elapsed = System.currentTimeMillis() - startTimeMs
                GpsRecorderModule.emitDuration(elapsed)
                handler.postDelayed(this, 1000L)
            }
        }
    }

    // Periodic flush to temp file
    private val flushTick = object : Runnable {
        override fun run() {
            if (isRecording) {
                flushToTempFile()
                handler.postDelayed(this, FLUSH_INTERVAL_MS)
            }
        }
    }

    /**
     * A simple POJO for a single GPS fix.
     */
    private data class GpsPoint(
        val lat: Double,
        val lon: Double,
        val alt: Double?,   // meters, may be null
        val speed: Float?,  // m/s, may be null
        val accuracy: Float?, // meters, may be null
        val timeMs: Long    // epoch millis
    )

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Service onCreate")
        // Try to recover state in case the service was restarted by the system
        recoverStateIfAny()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "onStartCommand action=${intent?.action} startId=$startId")
        when (intent?.action) {
            ACTION_START -> startRecording()
            ACTION_STOP, ACTION_NOTIFICATION_STOP -> stopRecording()
            null -> {
                // System restarted the service (START_STICKY). If we were recording, resume.
                Log.i(TAG, "Service restarted by system. Recovering state if any.")
                if (isRecording) {
                    startRecording(resume = true)
                } else {
                    // Nothing to do; stop the service to avoid leaving an idle foreground service.
                    stopSelf()
                }
            }
            else -> {
                Log.w(TAG, "Unknown action: ${intent.action}")
            }
        }
        // START_STICKY: system will restart the service if it has to kill it.
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // User swiped the app away from recents. We deliberately KEEP the service running
        // so the recording does not die. The user can stop it from the notification.
        Log.i(TAG, "onTaskRemoved - keeping service alive")
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        Log.i(TAG, "Service onDestroy")
        // If we are being destroyed while still recording, do a final flush so we don't lose
        // data. We do NOT release the wakelock yet because we may be restarted.
        if (isRecording) {
            flushToTempFile()
        }
        cleanupGpsAndWakeLock()
        super.onDestroy()
    }

    // ------------------------------------------------------------------
    // Recording lifecycle
    // ------------------------------------------------------------------

    private fun startRecording(resume: Boolean = false) {
        if (resume) {
            // System restarted the service (START_STICKY). Only resume if we genuinely
            // were recording; otherwise there is nothing to resume.
            if (!isRecording) {
                Log.i(TAG, "System restarted service but we weren't recording — stopping")
                stopSelf()
                return
            }
            Log.i(TAG, "Resuming recording after system restart")
            // Do NOT reset state — continue from where we left off.
        } else {
            // The user explicitly pressed START. Always start a fresh recording,
            // even if isRecording happens to be true (e.g. leftover state from a
            // previous session that was killed before stopRecording() could clear
            // SharedPreferences). Without this, totalDistanceM from the previous
            // session would leak into the new one — the "starts with 69 m" bug.
            if (isRecording) {
                Log.w(TAG, "User pressed START while isRecording=true (leftover state) — resetting")
            }
            startTimeMs = System.currentTimeMillis()
            pointCount = 0
            totalDistanceM = 0.0
            prevLat = null
            prevLon = null
            prevTimeMs = null
            satellitesUsed = 0
            lastFixTimeMs = 0L
            synchronized(pointBufferLock) { pointBuffer.clear() }
            tempFileName = "gps_temp_${startTimeMs}.gpx"
        }
        isRecording = true

        // Persist state so we can recover after a crash/restart
        persistState()

        // Acquire wakelock so CPU stays awake while screen is off
        acquireWakeLock()

        // Start the foreground notification FIRST (Android requires this within 5s of
        // startForegroundService()).
        startForegroundIfNeeded()

        // Start GPS + GNSS status tracking
        startLocationUpdates()
        startGnssStatusTracking()

        // Start duration tick + periodic flush
        handler.post(durationTick)
        handler.postDelayed(flushTick, FLUSH_INTERVAL_MS)

        // Reset temp file content with GPX header (overwrites any stale temp)
        if (!resume) {
            writeGpxHeaderToTempFile()
        }

        GpsRecorderModule.emitState(true, pointCount, System.currentTimeMillis() - startTimeMs)
        Log.i(TAG, "Recording started at $startTimeMs (resume=$resume)")
    }

    private fun stopRecording() {
        if (!isRecording) {
            Log.i(TAG, "Not recording, ignoring stop")
            // Make sure foreground state is cleared
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        Log.i(TAG, "Stopping recording")
        isRecording = false
        handler.removeCallbacks(durationTick)
        handler.removeCallbacks(flushTick)
        stopLocationUpdates()
        stopGnssStatusTracking()

        // Final flush + finalize the GPX file
        val savedFilePath = finalizeGpxFile()

        // Clear persisted state
        clearPersistedState()

        // Release wakelock
        releaseWakeLock()

        // Tell JS (if alive) that we saved a file
        GpsRecorderModule.emitSaved(savedFilePath, pointCount)
        GpsRecorderModule.emitState(false, 0, 0L)

        // Stop foreground + service
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ------------------------------------------------------------------
    // Foreground notification
    // ------------------------------------------------------------------

    private fun startForegroundIfNeeded() {
        ensureNotificationChannel()
        val notification = buildNotification(pointCount, getElapsedMs())
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // Android 14+ requires explicit foregroundServiceType and the
                // FOREGROUND_SERVICE_LOCATION permission.
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            Log.e(TAG, "startForeground failed", e)
        }
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.notification_channel_name),
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = getString(R.string.notification_channel_desc)
                    setShowBadge(false)
                    setSound(null, null)
                    enableVibration(false)
                }
                nm.createNotificationChannel(channel)
            }
        }
    }

    private fun buildNotification(points: Int, elapsedMs: Long): Notification {
        val mainIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val mainPi = PendingIntent.getActivity(
            this, 0, mainIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, GpsRecorderService::class.java).apply {
            action = ACTION_NOTIFICATION_STOP
        }
        val stopPi = PendingIntent.getService(
            this, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val text = getString(R.string.notification_text, points, formatDuration(elapsedMs))

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_gps_notification)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(mainPi)
            .addAction(0, getString(R.string.notification_action_stop), stopPi)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification() {
        if (!isRecording) return
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification(pointCount, getElapsedMs()))
    }

    // ------------------------------------------------------------------
    // GPS
    // ------------------------------------------------------------------

    private fun startLocationUpdates() {
        if (locationManager == null) {
            locationManager = getSystemService(LOCATION_SERVICE) as LocationManager
        }
        val lm = locationManager ?: run {
            Log.e(TAG, "No LocationManager")
            return
        }

        // Check permissions
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            Log.e(TAG, "No FINE_LOCATION permission")
            GpsRecorderModule.emitError("Location permission not granted")
            stopRecording()
            return
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
            Log.e(TAG, "No location provider enabled")
            GpsRecorderModule.emitError("No location provider enabled. Please enable location in settings.")
            stopRecording()
            return
        }

        for (p in providers) {
            try {
                lm.requestLocationUpdates(p, MIN_TIME_MS, MIN_DISTANCE_M, this, Looper.getMainLooper())
                Log.i(TAG, "Requested location updates from $p")
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException requesting updates from $p", e)
            } catch (e: IllegalArgumentException) {
                Log.e(TAG, "IllegalArg requesting updates from $p", e)
            }
        }

        // NOTE: We deliberately do NOT seed from lm.getLastKnownLocation() here.
        //
        // The previous version did:
        //     val last = lm.getLastKnownLocation(GPS_PROVIDER) ?: getLastKnownLocation(NETWORK_PROVIDER)
        //     if (last != null) onLocationChanged(last)
        //
        // That call returns whatever fix the OS happens to have cached, which is
        // frequently STALE — e.g. a fix from 30+ seconds ago when the user was a
        // few meters away from where they are now. That stale fix would be added
        // to pointBuffer and become prevLat/prevLon with no distance added (prev
        // was null). When the first FRESH fix arrived a moment later, the
        // Haversine distance from the stale prev to the fresh fix would be added
        // to totalDistanceM — producing the "starts with 9 m / 69 m" bug the user
        // reported.
        //
        // The always-on GNSS monitor in GpsRecorderModule already seeds the UI
        // with fix status as soon as the app opens, so removing this seed does
        // not degrade UX. The service simply waits for the first real fix from
        // requestLocationUpdates() above, which is guaranteed to be fresh.
    }

    private fun stopLocationUpdates() {
        locationManager?.removeUpdates(this)
    }

    // ------------------------------------------------------------------
    // GNSS status (satellite count for fix-type display)
    // ------------------------------------------------------------------

    /**
     * Registers a GnssStatus callback to track how many satellites are used in
     * the current fix. Used by [computeFixType] to distinguish 2D vs 3D fixes.
     */
    private fun startGnssStatusTracking() {
        val lm = locationManager ?: return
        if (gnssStatusCallback != null) return  // already registered
        val cb = object : GnssStatus.Callback() {
            override fun onSatelliteStatusChanged(status: GnssStatus) {
                var used = 0
                for (i in 0 until status.satelliteCount) {
                    if (status.usedInFix(i)) used++
                }
                satellitesUsed = used
                // Persist so JS can poll via getState() even without a new location event.
                try {
                    getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .edit()
                        .putInt(KEY_SATELLITES_USED, used)
                        .putString(KEY_FIX_TYPE, computeFixType())
                        .apply()
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to persist GNSS status", e)
                }
            }

            override fun onStarted() {
                Log.i(TAG, "GNSS engine started")
            }

            override fun onStopped() {
                Log.i(TAG, "GNSS engine stopped")
                satellitesUsed = 0
            }
        }
        try {
            lm.registerGnssStatusCallback(cb, Handler(Looper.getMainLooper()))
            gnssStatusCallback = cb
            Log.i(TAG, "Registered GNSS status callback")
        } catch (e: Exception) {
            Log.w(TAG, "registerGnssStatusCallback failed", e)
        }
    }

    private fun stopGnssStatusTracking() {
        val cb = gnssStatusCallback ?: return
        try {
            locationManager?.unregisterGnssStatusCallback(cb)
        } catch (e: Exception) {
            Log.w(TAG, "unregisterGnssStatusCallback failed", e)
        }
        gnssStatusCallback = null
        satellitesUsed = 0
    }

    override fun onLocationChanged(location: Location) {
        if (!isRecording) return
        val pt = GpsPoint(
            lat = location.latitude,
            lon = location.longitude,
            alt = if (location.hasAltitude()) location.altitude else null,
            speed = if (location.hasSpeed()) location.speed else null,
            accuracy = if (location.hasAccuracy()) location.accuracy else null,
            timeMs = if (location.time > 0) location.time else System.currentTimeMillis()
        )
        // A. Always reject stale cached fixes first. The OS occasionally hands us a
        // slightly stale fix right after requestLocationUpdates() is called, and
        // such a fix would poison prevLat/prevLon and inflate totalDistanceM on
        // the next fresh fix. This is the second half of the "starts with 9 m /
        // 69 m" fix (the first half is removing the getLastKnownLocation() seed).
        val fixAgeMs = System.currentTimeMillis() - pt.timeMs
        if (fixAgeMs > MAX_FIX_AGE_MS) {
            Log.w(TAG, "Dropping stale fix: age=${fixAgeMs}ms lat=${pt.lat} lon=${pt.lon}")
            return
        }
        // The "post_process_enabled" setting is now interpreted as ON-THE-FLY track
        // filtering: when it is on, noisy / wild points are dropped at write time
        // so the GPX buffer only ever contains clean, validated fixes and there is
        // nothing left to post-process at finalization. When it is off, every fix
        // is recorded raw (the fallback / diagnostic mode).
        if (isPostProcessEnabled()) {
            // B. Accuracy gate: skip fixes whose reported accuracy is worse than the
            // threshold. These are almost always multipath or cold-start noise.
            val acc = pt.accuracy
            if (acc != null && acc > ACCURACY_THRESHOLD_M) {
                Log.d(TAG, "On-the-fly filter: dropping low-accuracy fix (acc=${acc}m)")
                return
            }
            // C. Velocity-based plausibility gate: compute the instantaneous
            // velocity from the previous accepted fix to this candidate, and drop
            // the candidate if it implies the user moved faster than the walking /
            // running ceiling (20 km/h). This replaces the old static 1 km jump
            // gate, which only caught glitches that were already absurdly large.
            //
            //   velocity = haversine(prev, curr) / (t_curr - t_prev)
            //
            // A zero-dt fix (duplicate timestamp) is dropped because it would
            // imply infinite velocity.
            val pLat = prevLat
            val pLon = prevLon
            val pTime = prevTimeMs
            if (pLat != null && pLon != null && pTime != null) {
                val dtSec = (pt.timeMs - pTime) / 1000.0
                if (dtSec <= 0.0) {
                    Log.d(TAG, "On-the-fly filter: dropping zero-dt fix (dt=${dtSec}s)")
                    return
                }
                val d = haversineMeters(pLat, pLon, pt.lat, pt.lon)
                val velocityMps = d / dtSec
                if (velocityMps > MAX_VELOCITY_MPS) {
                    Log.d(TAG, "On-the-fly filter: dropping velocity outlier (v=${velocityMps}m/s d=${d}m dt=${dtSec}s)")
                    return
                }
                totalDistanceM += d
            }
            // D. Point passed both gates — commit it to the buffer and advance the
            // previous-fix cursor.
            synchronized(pointBufferLock) {
                pointBuffer.add(pt)
                pointCount = pointBuffer.size
            }
            prevLat = pt.lat
            prevLon = pt.lon
            prevTimeMs = pt.timeMs
            lastFixTimeMs = pt.timeMs
        } else {
            // E. Fallback: record every fix raw so the GPX file keeps the noisy
            // data, but still keep the displayed distance sane by routing the
            // accuracy/velocity gates through the distance accumulator only.
            synchronized(pointBufferLock) {
                pointBuffer.add(pt)
                pointCount = pointBuffer.size
            }
            accumulateDistance(pt)
            lastFixTimeMs = pt.timeMs
        }
        // Save current state to SharedPreferences so JS can poll via getState()
        // even if the event emitter is not delivering events reliably.
        saveLiveState(pt)
        // Emit the event with pointCount included so the JS UI updates in real time.
        GpsRecorderModule.emitLocation(
            pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
            computeFixType(), totalDistanceM, pt.timeMs, pointCount
        )
        updateNotification()
    }

    /**
     * Adds the Haversine distance between [pt] and the previous accepted fix to
     * [totalDistanceM]. Filters out fixes with poor accuracy or implausible
     * velocity (walk/run ceiling 20 km/h) to avoid GPS noise inflating the
     * distance. This is the path used when on-the-fly filtering is OFF (raw
     * recording) — the point itself is still added to the buffer (raw mode),
     * but the distance accumulator stays sane.
     */
    private fun accumulateDistance(pt: GpsPoint) {
        val acc = pt.accuracy
        if (acc != null && acc > ACCURACY_THRESHOLD_M) {
            // Fix too inaccurate to trust for distance — skip but don't reset prev.
            return
        }
        val pLat = prevLat
        val pLon = prevLon
        val pTime = prevTimeMs
        if (pLat != null && pLon != null && pTime != null) {
            val dtSec = (pt.timeMs - pTime) / 1000.0
            if (dtSec > 0.0) {
                val d = haversineMeters(pLat, pLon, pt.lat, pt.lon)
                val velocityMps = d / dtSec
                // Drop the contribution if the implied velocity exceeds the walk/
                // run ceiling. These are usually GPS glitches after a cold start
                // or tunnel exit; they would otherwise inflate totalDistanceM.
                if (velocityMps <= MAX_VELOCITY_MPS) {
                    totalDistanceM += d
                } else {
                    Log.d(TAG, "accumulateDistance: dropping velocity outlier (v=${velocityMps}m/s d=${d}m dt=${dtSec}s)")
                }
            }
        }
        prevLat = pt.lat
        prevLon = pt.lon
        prevTimeMs = pt.timeMs
    }

    /**
     * Returns the great-circle distance between two lat/lon points in meters.
     * Uses the Haversine formula.
     */
    private fun haversineMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val r = 6_371_000.0 // Earth radius in meters
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2)
        val c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
        return r * c
    }

    /**
     * Determines the GNSS fix type from the satellite count and fix recency:
     *  - "no fix" — no recent fix or no satellites used
     *  - "2D fix" — 1–3 satellites used in fix (lat/lon only)
     *  - "3D fix" — 4+ satellites used in fix (lat/lon + altitude)
     *
     * Falls back to using Location.hasAltitude() if satellite info isn't available.
     */
    private fun computeFixType(): String {
        val now = System.currentTimeMillis()
        val recentFix = lastFixTimeMs > 0 && (now - lastFixTimeMs) < NO_FIX_TIMEOUT_MS
        if (!recentFix) return "no fix"
        if (satellitesUsed == 0) return "no fix"
        return if (satellitesUsed >= 4) "3D fix" else "2D fix"
    }

    /**
     * Writes the current recording state + last fix to SharedPreferences.
     * Called on every GPS fix so that [GpsRecorderModule.getState] can return fresh data.
     */
    private fun saveLiveState(lastFix: GpsPoint? = null) {
        try {
            val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            prefs.putBoolean(KEY_IS_RECORDING, isRecording)
            prefs.putLong(KEY_START_TIME, startTimeMs)
            prefs.putInt(KEY_POINT_COUNT, pointCount)
            prefs.putString(KEY_TOTAL_DISTANCE, totalDistanceM.toString())
            prefs.putString(KEY_FIX_TYPE, computeFixType())
            prefs.putInt(KEY_SATELLITES_USED, satellitesUsed)
            val fix = lastFix ?: synchronized(pointBufferLock) { pointBuffer.lastOrNull() }
            if (fix != null) {
                prefs.putString(KEY_LAST_LAT, fix.lat.toString())
                prefs.putString(KEY_LAST_LON, fix.lon.toString())
                prefs.putString(KEY_LAST_ALT, fix.alt?.toString() ?: "")
                prefs.putString(KEY_LAST_SPEED, fix.speed?.toString() ?: "")
                prefs.putString(KEY_LAST_ACCURACY, fix.accuracy?.toString() ?: "")
                prefs.putLong(KEY_LAST_TIME_MS, fix.timeMs)
            }
            prefs.apply()
        } catch (e: Exception) {
            Log.w(TAG, "saveLiveState failed", e)
        }
    }

    // Required overrides for older Android API levels
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {
        Log.w(TAG, "Provider disabled: $provider")
    }
    @Deprecated("legacy")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}

    // ------------------------------------------------------------------
    // Wakelock
    // ------------------------------------------------------------------

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "trck:Recording")
        wakeLock?.setReferenceCounted(false)
        try {
            wakeLock?.acquire(6 * 60 * 60 * 1000L) /* 6 hours max, just in case */
            Log.i(TAG, "Wakelock acquired")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire wakelock", e)
        }
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
                Log.i(TAG, "Wakelock released")
            }
        } catch (e: Exception) {
            Log.w(TAG, "releaseWakeLock", e)
        }
        wakeLock = null
    }

    private fun cleanupGpsAndWakeLock() {
        stopLocationUpdates()
        stopGnssStatusTracking()
        releaseWakeLock()
        handler.removeCallbacks(durationTick)
        handler.removeCallbacks(flushTick)
    }

    // ------------------------------------------------------------------
    // GPX file writing
    // ------------------------------------------------------------------

    private fun getTempFile(): File {
        val name = tempFileName ?: "gps_temp_unknown.gpx"
        // Use app's external cache dir for temp file (no permission needed)
        return File(externalCacheDir ?: cacheDir, name)
    }

    /**
     * Reads the post-process setting from the SEPARATE settings prefs file.
     * The setting is written by GpsRecorderModule.setPostProcessEnabled() from JS.
     * Stored apart from `gps_recorder_state` so it survives the per-recording clear.
     */
    private fun isPostProcessEnabled(): Boolean {
        return getSharedPreferences("gps_recorder_settings", Context.MODE_PRIVATE)
            .getBoolean("post_process_enabled", false)
    }

    /**
     * Reads the Gaussian-smoothing setting from the SEPARATE settings prefs file.
     * When enabled, finalizeGpxFile() will (after writing the raw / on-the-fly-
     * filtered GPX file) read it back, apply a Gaussian kernel smoother to the
     * lat/lon coordinates, and overwrite the file with the smoothed track.
     *
     * Stored in the same prefs file as `post_process_enabled` so it survives the
     * per-recording state clear.
     */
    private fun isGaussianSmoothingEnabled(): Boolean {
        return getSharedPreferences("gps_recorder_settings", Context.MODE_PRIVATE)
            .getBoolean("gaussian_smoothing_enabled", false)
    }

    /**
     * Writes the GPX header to the temp file, replacing any previous content.
     * The temp file lives in the app's cache dir so it survives the JS app being killed
     * but is private to the app.
     */
    private fun writeGpxHeaderToTempFile() {
        try {
            val f = getTempFile()
            FileOutputStream(f).use { out ->
                out.write(gpxHeader().toByteArray(Charsets.UTF_8))
                out.write("  <trk>\n    <name>GPS Recording</name>\n    <trkseg>\n".toByteArray(Charsets.UTF_8))
            }
        } catch (e: Exception) {
            Log.e(TAG, "writeGpxHeaderToTempFile failed", e)
        }
    }

    /**
     * Flushes the current in-memory points to the temp file. We rewrite the whole temp
     * file on each flush for simplicity (point counts are typically in the thousands,
     * well under a megabyte).
     */
    private fun flushToTempFile() {
        try {
            val snapshot: List<GpsPoint> = synchronized(pointBufferLock) {
                ArrayList(pointBuffer)
            }
            val f = getTempFile()
            FileOutputStream(f).use { out ->
                out.write(gpxHeader().toByteArray(Charsets.UTF_8))
                out.write("  <trk>\n    <name>GPS Recording</name>\n    <trkseg>\n".toByteArray(Charsets.UTF_8))
                for (p in snapshot) {
                    out.write(formatGpxPoint(p).toByteArray(Charsets.UTF_8))
                }
                out.write("    </trkseg>\n  </trk>\n</gpx>\n".toByteArray(Charsets.UTF_8))
            }
        } catch (e: Exception) {
            Log.e(TAG, "flushToTempFile failed", e)
        }
    }

    /**
     * Finalizes the GPX file: writes a complete GPX file (header + all buffered
     * points + footer) and saves it to the public Downloads folder.
     *
     * Track filtering now happens ON-THE-FLY inside [onLocationChanged]: when the
     * setting is enabled the buffer only ever holds clean, validated points, so
     * there is nothing left to post-process here and the heavy offline parser is
     * bypassed (we always pass postProcess = false to the save routines). When the
     * setting is disabled the buffer holds the raw fixes, which is exactly what we
     * want to persist as the fallback.
     *
     * On API >= 29 we use MediaStore.Downloads so the file is visible to other apps.
     * On older APIs we write directly to Environment.DIRECTORY_DOWNLOADS.
     *
     * Returns the human-readable path/URI of the saved file.
     */
    private fun finalizeGpxFile(): String {
        val snapshot: List<GpsPoint> = synchronized(pointBufferLock) {
            ArrayList(pointBuffer)
        }

        val timestamp = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US)
            .format(Date(startTimeMs))
        val fileName = "trck_$timestamp.gpx"

        val rawGpxContent = buildString {
            append(gpxHeader())
            append("  <trk>\n")
            append("    <name>GPS Recording $timestamp</name>\n")
            append("    <trkseg>\n")
            for (p in snapshot) {
                append(formatGpxPoint(p))
            }
            append("    </trkseg>\n")
            append("  </trk>\n")
            append("</gpx>\n")
        }

        val rawBytes = rawGpxContent.toByteArray(Charsets.UTF_8)
        // On-the-fly filtering (if enabled) was already applied in onLocationChanged,
        // so the buffer is clean by this point. The legacy offline post-processor
        // (postProcessGpx) is intentionally NOT invoked here — it has been superseded
        // by the on-the-fly filter. The only optional finalize-time step left is the
        // Gaussian kernel smoothing, controlled by its own setting.
        val doGaussian = isGaussianSmoothingEnabled()
        Log.i(
            TAG,
            "finalizeGpxFile: points=${snapshot.size} onTheFlyFilter=${isPostProcessEnabled()} gaussianSmoothing=$doGaussian"
        )

        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveViaMediaStore(fileName, rawBytes, gaussianSmooth = doGaussian)
            } else {
                saveViaLegacyFile(fileName, rawBytes, gaussianSmooth = doGaussian)
            }
        } catch (e: Exception) {
            Log.e(TAG, "finalizeGpxFile failed; falling back to cache", e)
            // Last resort: write to cache and return its path (raw only, no smoothing)
            try {
                val f = File(externalCacheDir ?: cacheDir, fileName)
                FileOutputStream(f).use { it.write(rawBytes) }
                "Cache fallback: ${f.absolutePath}"
            } catch (e2: Exception) {
                Log.e(TAG, "Even cache fallback failed", e2)
                "Save failed: ${e2.message}"
            }
        } finally {
            // Clean up the temp file
            try { getTempFile().delete() } catch (_: Exception) {}
        }
    }

    private fun saveViaMediaStore(
        fileName: String,
        rawBytes: ByteArray,
        gaussianSmooth: Boolean = false
    ): String {
        val resolver = contentResolver
        val values = android.content.ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            put(MediaStore.MediaColumns.MIME_TYPE, "application/gpx+xml")
            // Put it under Downloads/trck/ so it's easy to find.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/trck")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
        }
        val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Downloads.EXTERNAL_CONTENT_URI
        } else {
            MediaStore.Files.getContentUri("external")
        }
        val uri = resolver.insert(collection, values)
            ?: throw java.io.IOException("MediaStore insert returned null")
        try {
            // Step 1: write the RAW data to the file.
            resolver.openOutputStream(uri)?.use { out: OutputStream ->
                out.write(rawBytes)
                out.flush()
            } ?: throw java.io.IOException("Cannot open output stream for $uri")

            // Step 2: if Gaussian smoothing is enabled, read the raw file back,
            // apply the kernel smoother, and OVERWRITE the file with the smoothed
            // track.
            if (gaussianSmooth) {
                val rawText = resolver.openInputStream(uri)?.use { it.readBytes() }
                    ?.toString(Charsets.UTF_8) ?: ""
                val smoothedText = try {
                    gaussianSmoothGpx(rawText)
                } catch (e: Exception) {
                    Log.e(TAG, "gaussianSmoothGpx failed; keeping raw file", e)
                    rawText
                }
                val smoothedBytes = smoothedText.toByteArray(Charsets.UTF_8)
                // "wt" = write-truncate: replaces the file's contents.
                resolver.openOutputStream(uri, "wt")?.use { out: OutputStream ->
                    out.write(smoothedBytes)
                    out.flush()
                } ?: throw java.io.IOException("Cannot reopen output stream for $uri (gaussian)")
                Log.i(TAG, "Gaussian-smoothed GPX written (${smoothedBytes.size} bytes)")
            }
        } finally {
            // Mark as not pending so it becomes visible, regardless of whether
            // smoothing succeeded (we always want the file accessible).
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val done = android.content.ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
                resolver.update(uri, done, null, null)
            }
        }
        return "Downloads/trck/$fileName"
    }

    private fun saveViaLegacyFile(
        fileName: String,
        rawBytes: ByteArray,
        gaussianSmooth: Boolean = false
    ): String {
        @Suppress("DEPRECATION")
        val downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val targetDir = File(downloadsDir, "trck").apply { if (!exists()) mkdirs() }
        val f = File(targetDir, fileName)
        // Step 1: write raw bytes.
        FileOutputStream(f).use { it.write(rawBytes) }
        // Step 2: if Gaussian smoothing is enabled, read back, smooth, overwrite.
        if (gaussianSmooth) {
            val rawText = f.readText(Charsets.UTF_8)
            val smoothedText = try {
                gaussianSmoothGpx(rawText)
            } catch (e: Exception) {
                Log.e(TAG, "gaussianSmoothGpx failed; keeping raw file", e)
                rawText
            }
            FileOutputStream(f).use { it.write(smoothedText.toByteArray(Charsets.UTF_8)) }
            Log.i(TAG, "Gaussian-smoothed GPX written to ${f.absolutePath}")
        }
        return f.absolutePath
    }

    // ------------------------------------------------------------------
    // Post-processing algorithm
    // ------------------------------------------------------------------

    /**
     * Post-processes the raw GPX content. Implements the user-specified algorithm:
     *
     *   1. Parse all trkpt (lat/lon/ele/time/speed/accuracy).
     *   2. Sort by timestamp ascending (stable).
     *   3. Drop points with accuracy missing or >= 15.0 m.
     *   4. Drop duplicate-timestamp points (dt == 0).
     *   5. Defensive jump sweep: drop points still producing >= 15.0 m jump vs
     *      previous kept.
     *   6. Interpolate remaining outages (gaps >= 5.0 s) at 1.0 Hz. Synthetic
     *      points are tagged <interpolated>true</interpolated> in <extensions>.
     *
     * If the input has no parseable trkpt, it is returned unchanged so the user
     * still gets a (raw) file rather than nothing.
     */
    private fun postProcessGpx(rawGpx: String): String {
        // 1. Parse all trkpt
        val parsed = mutableListOf<GpxTrkPt>()
        val regex = Regex("<trkpt lat=\"([^\"]+)\" lon=\"([^\"]+)\">(.*?)</trkpt>", RegexOption.DOT_MATCHES_ALL)
        for (m in regex.findAll(rawGpx)) {
            val lat = m.groupValues[1].toDoubleOrNull() ?: continue
            val lon = m.groupValues[2].toDoubleOrNull() ?: continue
            val inner = m.groupValues[3]
            val ele = Regex("<ele>([^<]+)</ele>").find(inner)?.groupValues?.get(1)?.toDoubleOrNull()
            val speed = Regex("<speed>([^<]+)</speed>").find(inner)?.groupValues?.get(1)?.toFloatOrNull()
            val acc = Regex("<accuracy>([^<]+)</accuracy>").find(inner)?.groupValues?.get(1)?.toFloatOrNull()
            val timeIso = Regex("<time>([^<]+)</time>").find(inner)?.groupValues?.get(1)
            val timeMs = parseIsoTime(timeIso) ?: continue
            parsed.add(GpxTrkPt(lat, lon, ele, speed, acc, timeMs, interpolated = false))
        }
        if (parsed.isEmpty()) {
            Log.w(TAG, "postProcessGpx: no trkpt found, returning raw input")
            return rawGpx
        }
        Log.i(TAG, "postProcessGpx: parsed ${parsed.size} points")

        // 2. Sort by timestamp ascending (stable — Kotlin's sortedBy is stable).
        val sorted = parsed.sortedBy { it.timeMs }

        // 3. Drop points with accuracy missing or >= 15.0 m.
        val filteredAcc = sorted.filter { p ->
            val a = p.accuracy
            a != null && a < POST_PROCESS_ACCURACY_THRESHOLD_M
        }
        Log.i(TAG, "postProcessGpx: after accuracy filter -> ${filteredAcc.size}")

        // 4. Drop duplicate-timestamp points (dt == 0).
        val filteredDup = ArrayList<GpxTrkPt>(filteredAcc.size)
        var lastT = Long.MIN_VALUE
        for (p in filteredAcc) {
            if (p.timeMs != lastT) {
                filteredDup.add(p)
                lastT = p.timeMs
            }
        }
        Log.i(TAG, "postProcessGpx: after duplicate-timestamp filter -> ${filteredDup.size}")

        // 5. Defensive jump sweep: drop points still producing >= 15.0 m jump vs
        //    previous kept. (We use a fresh threshold constant so this stays
        //    decoupled from the recording-time ACCURACY_THRESHOLD_M.)
        val filteredJump = ArrayList<GpxTrkPt>(filteredDup.size)
        for (p in filteredDup) {
            val prev = filteredJump.lastOrNull()
            if (prev == null) {
                filteredJump.add(p)
            } else {
                val d = haversineMeters(prev.lat, prev.lon, p.lat, p.lon)
                if (d < POST_PROCESS_JUMP_THRESHOLD_M) {
                    filteredJump.add(p)
                }
                // else: drop (>= 15 m jump from previous kept)
            }
        }
        Log.i(TAG, "postProcessGpx: after jump sweep -> ${filteredJump.size}")

        // 6. Interpolate remaining outages (gaps >= 5.0 s) at 1.0 Hz.
        //    Synthetic points are tagged <interpolated>true</interpolated>.
        val final = ArrayList<GpxTrkPt>(filteredJump.size * 2)
        if (filteredJump.isNotEmpty()) {
            final.add(filteredJump[0])
            for (i in 1 until filteredJump.size) {
                val prev = filteredJump[i - 1]
                val curr = filteredJump[i]
                val dtMs = curr.timeMs - prev.timeMs
                val dtSec = dtMs / 1000.0
                if (dtSec >= POST_PROCESS_GAP_THRESHOLD_S) {
                    // Add a synthetic point at every whole second strictly between
                    // prev and curr. E.g. dt = 7.0s -> k = 1..6 (6 points).
                    var k = 1
                    while (true) {
                        val tSyn = prev.timeMs + k * 1000L
                        if (tSyn >= curr.timeMs) break
                        val frac = (tSyn - prev.timeMs).toDouble() / dtMs.toDouble()
                        val lat = prev.lat + (curr.lat - prev.lat) * frac
                        val lon = prev.lon + (curr.lon - prev.lon) * frac
                        val ele = if (prev.ele != null && curr.ele != null)
                            prev.ele + (curr.ele - prev.ele) * frac else null
                        val speed = if (prev.speed != null && curr.speed != null)
                            (prev.speed + (curr.speed - prev.speed) * frac).toFloat() else null
                        final.add(GpxTrkPt(lat, lon, ele, speed, null, tSyn, interpolated = true))
                        k++
                    }
                }
                final.add(curr)
            }
        }
        Log.i(TAG, "postProcessGpx: after interpolation -> ${final.size} points")

        // Rebuild GPX. Preserve the original <name> if present, else use a default.
        val origName = Regex("<name>([^<]*)</name>").find(rawGpx)?.groupValues?.get(1)
            ?: "GPS Recording"
        return buildString {
            append(gpxHeader())
            append("  <trk>\n")
            append("    <name>").append(origName).append("</name>\n")
            append("    <trkseg>\n")
            for (p in final) {
                append(formatGpxPointWithInterpolated(p))
            }
            append("    </trkseg>\n")
            append("  </trk>\n")
            append("</gpx>\n")
        }
    }

    /**
     * Gaussian / kernel smoothing of the GPX track.
     *
     * Replaces each point's lat/lon (and altitude, if present) with a weighted
     * average of itself and its neighbours within ±GAUSSIAN_HALF_WINDOW points.
     * The weights follow a Gaussian kernel:
     *
     *     w(i, j) = exp( -0.5 * ((i - j) / GAUSSIAN_SIGMA)^2 )
     *
     * Timestamps, speed, and accuracy are preserved verbatim — only the spatial
     * coordinates are smoothed. The output has the SAME number of points as the
     * input (no interpolation, no dropping); only the lat/lon/ele values change.
     *
     * Effect: single-fix GPS glitches (which typically look like a spike 20–80 m
     * away from the true track) get pulled back towards their neighbours, since
     * the Gaussian-weighted average is dominated by the surrounding clean fixes.
     * Real corners are preserved reasonably well because the kernel is narrow
     * (±5 points at 1 Hz = ±5 s window).
     *
     * If parsing fails or no trkpt is found, the input is returned unchanged so
     * the user still gets a usable (raw) file rather than nothing.
     */
    private fun gaussianSmoothGpx(rawGpx: String): String {
        // 1. Parse all trkpt entries.
        val parsed = mutableListOf<GpxTrkPt>()
        val regex = Regex("<trkpt lat=\"([^\"]+)\" lon=\"([^\"]+)\">(.*?)</trkpt>", RegexOption.DOT_MATCHES_ALL)
        for (m in regex.findAll(rawGpx)) {
            val lat = m.groupValues[1].toDoubleOrNull() ?: continue
            val lon = m.groupValues[2].toDoubleOrNull() ?: continue
            val inner = m.groupValues[3]
            val ele = Regex("<ele>([^<]+)</ele>").find(inner)?.groupValues?.get(1)?.toDoubleOrNull()
            val speed = Regex("<speed>([^<]+)</speed>").find(inner)?.groupValues?.get(1)?.toFloatOrNull()
            val acc = Regex("<accuracy>([^<]+)</accuracy>").find(inner)?.groupValues?.get(1)?.toFloatOrNull()
            val timeIso = Regex("<time>([^<]+)</time>").find(inner)?.groupValues?.get(1)
            val timeMs = parseIsoTime(timeIso) ?: continue
            parsed.add(GpxTrkPt(lat, lon, ele, speed, acc, timeMs, interpolated = false))
        }
        if (parsed.isEmpty()) {
            Log.w(TAG, "gaussianSmoothGpx: no trkpt found, returning raw input")
            return rawGpx
        }
        Log.i(TAG, "gaussianSmoothGpx: parsed ${parsed.size} points, half-window=$GAUSSIAN_HALF_WINDOW sigma=$GAUSSIAN_SIGMA")

        // 2. Pre-compute the Gaussian kernel weights for offsets -W..+W.
        //    w[k] = exp(-0.5 * (k / sigma)^2), k in [-W, W].
        val w = DoubleArray(2 * GAUSSIAN_HALF_WINDOW + 1) { kOff ->
            val k = (kOff - GAUSSIAN_HALF_WINDOW).toDouble()
            Math.exp(-0.5 * (k / GAUSSIAN_SIGMA) * (k / GAUSSIAN_SIGMA))
        }

        // 3. Smooth each point.
        val smoothed = ArrayList<GpxTrkPt>(parsed.size)
        for (i in parsed.indices) {
            var sumW = 0.0
            var sumLat = 0.0
            var sumLon = 0.0
            var sumEle: Double? = null
            var nEle = 0
            var sumEleVal = 0.0
            for (kOff in 0 until w.size) {
                val j = i + (kOff - GAUSSIAN_HALF_WINDOW)
                if (j < 0 || j >= parsed.size) continue
                val weight = w[kOff]
                sumW += weight
                sumLat += parsed[j].lat * weight
                sumLon += parsed[j].lon * weight
                val e = parsed[j].ele
                if (e != null) {
                    sumEleVal += e * weight
                    nEle++
                    sumEle = sumEleVal
                }
            }
            val newLat = if (sumW > 0.0) sumLat / sumW else parsed[i].lat
            val newLon = if (sumW > 0.0) sumLon / sumW else parsed[i].lon
            val newEle = if (nEle > 0 && sumEle != null) sumEle / nEle else null
            smoothed.add(
                GpxTrkPt(
                    lat = newLat,
                    lon = newLon,
                    ele = newEle,
                    speed = parsed[i].speed,
                    accuracy = parsed[i].accuracy,
                    timeMs = parsed[i].timeMs,
                    interpolated = false
                )
            )
        }
        Log.i(TAG, "gaussianSmoothGpx: smoothed ${smoothed.size} points")

        // 4. Rebuild GPX, preserving the original <name> if present.
        val origName = Regex("<name>([^<]*)</name>").find(rawGpx)?.groupValues?.get(1)
            ?: "GPS Recording"
        return buildString {
            append(gpxHeader())
            append("  <trk>\n")
            append("    <name>").append(origName).append("</name>\n")
            append("    <trkseg>\n")
            for (p in smoothed) {
                append(formatGpxPointWithInterpolated(p))
            }
            append("    </trkseg>\n")
            append("  </trk>\n")
            append("</gpx>\n")
        }
    }

    /**
     * Like [formatGpxPoint] but also emits an <interpolated>true</interpolated>
     * tag inside <extensions> when [p.interpolated] is true. Synthetic points
     * have no accuracy, so we always emit <extensions> for them.
     */
    private fun formatGpxPointWithInterpolated(p: GpxTrkPt): String {
        val sb = StringBuilder()
        sb.append("      <trkpt lat=\"").append(p.lat).append("\" lon=\"").append(p.lon).append("\">\n")
        if (p.ele != null) {
            sb.append("        <ele>").append(p.ele).append("</ele>\n")
        }
        sb.append("        <time>").append(isoTime(p.timeMs)).append("</time>\n")
        if (p.speed != null) {
            sb.append("        <speed>").append(p.speed).append("</speed>\n")
        }
        if (p.accuracy != null || p.interpolated) {
            sb.append("        <extensions>\n")
            if (p.accuracy != null) {
                sb.append("          <accuracy>").append(p.accuracy).append("</accuracy>\n")
            }
            if (p.interpolated) {
                sb.append("          <interpolated>true</interpolated>\n")
            }
            sb.append("        </extensions>\n")
        }
        sb.append("      </trkpt>\n")
        return sb.toString()
    }

    /**
     * Lightweight trkpt representation used by the post-processing pipeline.
     * Carries an [interpolated] flag so synthetic points can be tagged in the
     * output GPX.
     */
    private data class GpxTrkPt(
        val lat: Double,
        val lon: Double,
        val ele: Double?,
        val speed: Float?,
        val accuracy: Float?,
        val timeMs: Long,
        val interpolated: Boolean = false
    )

    // ------------------------------------------------------------------
    // GPX formatting helpers
    // ------------------------------------------------------------------

    private fun gpxHeader(): String {
        val nowIso = isoTime(System.currentTimeMillis())
        return StringBuilder()
            .append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
            .append("<gpx version=\"1.1\" creator=\"GpsRecorder\" ")
            .append("xmlns=\"http://www.topografix.com/GPX/1/1\" ")
            .append("xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" ")
            .append("xsi:schemaLocation=\"http://www.topografix.com/GPX/1/1 ")
            .append("http://www.topografix.com/GPX/1/1/gpx.xsd\">\n")
            .append("  <metadata><time>").append(nowIso).append("</time></metadata>\n")
            .toString()
    }

    private fun formatGpxPoint(p: GpsPoint): String {
        val sb = StringBuilder()
        sb.append("      <trkpt lat=\"").append(p.lat).append("\" lon=\"").append(p.lon).append("\">\n")
        if (p.alt != null) {
            sb.append("        <ele>").append(p.alt).append("</ele>\n")
        }
        sb.append("        <time>").append(isoTime(p.timeMs)).append("</time>\n")
        if (p.speed != null) {
            // GPX speed is in m/s
            sb.append("        <speed>").append(p.speed).append("</speed>\n")
        }
        if (p.accuracy != null) {
            // There's no standard GPX tag for accuracy; we use <extensions> with a custom
            // namespace so it's still valid GPX but the accuracy info is preserved.
            sb.append("        <extensions>\n")
            sb.append("          <accuracy>").append(p.accuracy).append("</accuracy>\n")
            sb.append("        </extensions>\n")
        }
        sb.append("      </trkpt>\n")
        return sb.toString()
    }

    private fun isoTime(ms: Long): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        return sdf.format(Date(ms))
    }

    // ------------------------------------------------------------------
    // State persistence (for crash/restart recovery)
    // ------------------------------------------------------------------

    private fun persistState() {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
        prefs.putBoolean(KEY_IS_RECORDING, isRecording)
        prefs.putLong(KEY_START_TIME, startTimeMs)
        prefs.putInt(KEY_POINT_COUNT, pointCount)
        prefs.putString(KEY_TEMP_FILE_NAME, tempFileName)
        prefs.putString(KEY_TOTAL_DISTANCE, totalDistanceM.toString())
        prefs.apply()
    }

    private fun clearPersistedState() {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
        prefs.clear()
        prefs.apply()
    }

    private fun recoverStateIfAny() {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (prefs.getBoolean(KEY_IS_RECORDING, false)) {
            isRecording = true
            startTimeMs = prefs.getLong(KEY_START_TIME, System.currentTimeMillis())
            pointCount = prefs.getInt(KEY_POINT_COUNT, 0)
            tempFileName = prefs.getString(KEY_TEMP_FILE_NAME, null)
            totalDistanceM = prefs.getString(KEY_TOTAL_DISTANCE, "0")?.toDoubleOrNull() ?: 0.0
            Log.i(TAG, "Recovered recording state: start=$startTimeMs count=$pointCount temp=$tempFileName dist=$totalDistanceM")
            // Try to reload buffered points from the temp file
            reloadPointsFromTempFile()
            // Restore prevLat/prevLon from the last buffered point so distance
            // accumulation continues smoothly after a service restart.
            synchronized(pointBufferLock) {
                pointBuffer.lastOrNull()?.let { last ->
                    prevLat = last.lat
                    prevLon = last.lon
                    lastFixTimeMs = last.timeMs
                }
            }
        }
    }

    private fun reloadPointsFromTempFile() {
        try {
            val f = getTempFile()
            if (!f.exists()) return
            val content = f.readText(Charsets.UTF_8)
            // Parse trkpt entries with a very simple regex - we wrote them, so format is known.
            val regex = Regex("<trkpt lat=\"([^\"]+)\" lon=\"([^\"]+)\">(.*?)</trkpt>", RegexOption.DOT_MATCHES_ALL)
            synchronized(pointBufferLock) {
                pointBuffer.clear()
                for (m in regex.findAll(content)) {
                    val lat = m.groupValues[1].toDoubleOrNull() ?: continue
                    val lon = m.groupValues[2].toDoubleOrNull() ?: continue
                    val inner = m.groupValues[3]
                    val alt = Regex("<ele>([^<]+)</ele>").find(inner)?.groupValues?.get(1)?.toDoubleOrNull()
                    val speed = Regex("<speed>([^<]+)</speed>").find(inner)?.groupValues?.get(1)?.toFloatOrNull()
                    val acc = Regex("<accuracy>([^<]+)</accuracy>").find(inner)?.groupValues?.get(1)?.toFloatOrNull()
                    val timeIso = Regex("<time>([^<]+)</time>").find(inner)?.groupValues?.get(1)
                    val timeMs = parseIsoTime(timeIso) ?: System.currentTimeMillis()
                    pointBuffer.add(GpsPoint(lat, lon, alt, speed, acc, timeMs))
                }
                pointCount = pointBuffer.size
            }
            Log.i(TAG, "Reloaded ${pointCount} points from temp file")
        } catch (e: Exception) {
            Log.e(TAG, "reloadPointsFromTempFile failed", e)
        }
    }

    private fun parseIsoTime(iso: String?): Long? {
        if (iso == null) return null
        return try {
            val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            sdf.timeZone = TimeZone.getTimeZone("UTC")
            sdf.parse(iso)?.time
        } catch (e: Exception) {
            null
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private fun getElapsedMs(): Long =
        if (isRecording) System.currentTimeMillis() - startTimeMs else 0L

    private fun formatDuration(ms: Long): String {
        val totalSec = ms / 1000
        val h = totalSec / 3600
        val m = (totalSec % 3600) / 60
        val s = totalSec % 60
        return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s)
        else String.format(Locale.US, "%02d:%02d", m, s)
    }
}
