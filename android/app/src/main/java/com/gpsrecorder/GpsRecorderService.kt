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
    }

    private var locationManager: LocationManager? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var handler: Handler = Handler(Looper.getMainLooper())

    // Recording state (persisted to SharedPreferences for recovery)
    @Volatile private var isRecording = false
    private var startTimeMs: Long = 0L
    private var pointCount: Int = 0
    private var tempFileName: String? = null

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
        if (isRecording) {
            Log.i(TAG, "Already recording, ignoring start")
            // Still make sure we are in foreground (e.g. after system restart)
            startForegroundIfNeeded()
            return
        }
        if (!resume) {
            startTimeMs = System.currentTimeMillis()
            pointCount = 0
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

        // Start GPS
        startLocationUpdates()

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

        // Try to get an immediate last known location so the user sees something quickly
        try {
            val last = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
            if (last != null) {
                onLocationChanged(last)
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "Cannot get last known location", e)
        }
    }

    private fun stopLocationUpdates() {
        locationManager?.removeUpdates(this)
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
        synchronized(pointBufferLock) {
            pointBuffer.add(pt)
            pointCount = pointBuffer.size
        }
        // Save current state to SharedPreferences so JS can poll via getState()
        // even if the event emitter is not delivering events reliably.
        saveLiveState(pt)
        // Emit the event with pointCount included so the JS UI updates in real time.
        GpsRecorderModule.emitLocation(pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy, pt.timeMs, pointCount)
        updateNotification()
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
     * Finalizes the GPX file: writes a complete GPX file (header + all points + footer)
     * and saves it to the public Downloads folder.
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

        val gpxContent = buildString {
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

        val bytes = gpxContent.toByteArray(Charsets.UTF_8)

        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveViaMediaStore(fileName, bytes)
            } else {
                saveViaLegacyFile(fileName, bytes)
            }
        } catch (e: Exception) {
            Log.e(TAG, "finalizeGpxFile failed; falling back to cache", e)
            // Last resort: write to cache and return its path
            try {
                val f = File(externalCacheDir ?: cacheDir, fileName)
                FileOutputStream(f).use { it.write(bytes) }
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

    private fun saveViaMediaStore(fileName: String, bytes: ByteArray): String {
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
        resolver.openOutputStream(uri)?.use { out: OutputStream ->
            out.write(bytes)
            out.flush()
        } ?: throw java.io.IOException("Cannot open output stream for $uri")
        // Mark as not pending so it becomes visible
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val done = android.content.ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            resolver.update(uri, done, null, null)
        }
        return "Downloads/trck/$fileName"
    }

    private fun saveViaLegacyFile(fileName: String, bytes: ByteArray): String {
        @Suppress("DEPRECATION")
        val downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val targetDir = File(downloadsDir, "trck").apply { if (!exists()) mkdirs() }
        val f = File(targetDir, fileName)
        FileOutputStream(f).use { it.write(bytes) }
        return f.absolutePath
    }

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
            Log.i(TAG, "Recovered recording state: start=$startTimeMs count=$pointCount temp=$tempFileName")
            // Try to reload buffered points from the temp file
            reloadPointsFromTempFile()
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
