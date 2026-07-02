package com.gpsrecorder

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
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
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.util.Date
import java.util.LinkedList

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

    // O7/O24: extracted helpers
    internal val notifier = GpsRecorderNotification(this)

    // O7/O24 round 2: further extracted helpers
    internal val locationSource = LocationSource(
        service = this,
        listener = this,
        onFatalError = { msg ->
            GpsRecorderModule.emitError(msg, fatal = true)
            stopRecording()
        },
        onGnssStatusPersist = { sats, fixType ->
            try {
                getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
                    .edit()
                    .putInt(KEY_SATELLITES_USED, sats)
                    .putString(KEY_FIX_TYPE, fixType)
                    .apply()
            } catch (e: Exception) {
                android.util.Log.w(TAG, "Failed to persist GNSS status", e)
            }
        },
    )
    internal val wakeLockManager = WakeLockManager(this)
    internal val tempFileBuffer = TempFileBuffer(
        service = this,
        segmentsSnapshot = { segmentsSnapshot() },
        setBuffer = { segments, totalPoints ->
            synchronized(pointBufferLock) {
                trackSegments.clear()
                currentSegment = if (segments.isEmpty()) ArrayList() else ArrayList(segments.last())
                if (segments.size > 1) {
                    for (i in 0 until segments.size - 1) {
                        trackSegments.add(ArrayList(segments[i]))
                    }
                }
                pointCount = totalPoints
            }
        },
        setAppendState = { init, segs, size -> },
    )
    internal val gpxFileSaver = GpxFileSaver(
        service = this,
        segmentsSnapshot = { segmentsSnapshot() },
        startTimeMs = { startTimeMs },
        deleteTempFile = { tempFileBuffer.deleteTempFile() },
    )

    // K5: state persistence / recovery helper.
    private val stateRepository = StateRepository(this)

    companion object {
        internal const val TAG = "GpsRecorderService"

        const val ACTION_START = "com.gpsrecorder.action.START"
        const val ACTION_STOP = "com.gpsrecorder.action.STOP"
        const val ACTION_NOTIFICATION_STOP = "com.gpsrecorder.action.NOTIF_STOP"

        const val NOTIFICATION_ID = 0xC0DE
        const val CHANNEL_ID = "gps_recorder_channel"

        // SharedPreferences keys for crash/restart recovery + live state queries
        internal const val PREFS_NAME = "gps_recorder_state"
        internal const val KEY_IS_RECORDING = "is_recording"
        internal const val KEY_START_TIME = "start_time_ms"
        internal const val KEY_POINT_COUNT = "point_count"
        internal const val KEY_TEMP_FILE_NAME = "temp_file_name"
        internal const val KEY_TOTAL_DISTANCE = "total_distance_m"
        internal const val KEY_FIX_TYPE = "fix_type"
        internal const val KEY_SATELLITES_USED = "satellites_used"

        // ---- Auto-pause / gap-detection prefs (Phase 1) ----
        // KEY_AUTO_PAUSE_ENABLED / KEY_GAP_DETECTION_ENABLED live in the
        // SEPARATE settings prefs file ("gps_recorder_settings") so they
        // survive the per-recording state clear in stopRecording().
        // KEY_IS_AUTO_PAUSED / KEY_SIGNAL_LOST / KEY_MOVING_MS live in
        // PREFS_NAME because they are per-recording live state, just like
        // KEY_IS_RECORDING.
        internal const val KEY_IS_AUTO_PAUSED = "is_auto_paused"
        internal const val KEY_SIGNAL_LOST = "signal_lost"
        internal const val KEY_MOVING_MS = "moving_ms"
        // Last fix (updated on every GPS callback so JS can poll via getState())
        internal const val KEY_LAST_LAT = "last_lat"
        internal const val KEY_LAST_LON = "last_lon"
        internal const val KEY_LAST_ALT = "last_alt"
        internal const val KEY_LAST_SPEED = "last_speed"
        internal const val KEY_LAST_ACCURACY = "last_accuracy"
        internal const val KEY_LAST_TIME_MS = "last_time_ms"

        // L13 fix: MediaStore URI of the most recently saved GPX file (as a
        // string). Populated by saveViaMediaStore() on API 29+ so that
        // gpxFileSaver.recomputeDistanceFromSavedGpx() can open the file via ContentResolver
        // instead of trying to resolve the MediaStore-relative path through
        // Environment.getExternalStoragePublicDirectory() (which on scoped
        // storage points to a different directory than the MediaStore-scoped
        // Downloads — file.exists() returns false even though the file was
        // just written).
        private const val KEY_LAST_SAVED_URI = "last_saved_uri"

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
        // points within ±GpxPostProcessors.GAUSSIAN_HALF_WINDOW of it. ±5 points at 1 Hz covers a
        // ~11 s window, which is large enough to suppress single-fix glitches but
        // small enough not to round off real corners.
        // Gaussian sigma (in points, not seconds) — controls how flat the kernel
        // is. With sigma=1.5 and a ±5 window, the weights drop to ~1% of the peak
        // at the edges, so the window edges contribute negligibly.

        // ---- Legacy post-processing algorithm thresholds ----
        // (kept as constants so they're easy to tune.)
        private const val POST_PROCESS_ACCURACY_THRESHOLD_M = 15.0f
        private const val POST_PROCESS_JUMP_THRESHOLD_M = 15.0
        private const val POST_PROCESS_GAP_THRESHOLD_S = 5.0

        // ---- Auto-pause (stop detection) (Phase 3) ----
        // Sliding window of recent raw fixes used to detect stops. We keep
        // the last AUTO_PAUSE_RAW_WINDOW_MS of fixes (regardless of whether
        // they passed the on-the-fly filter) and look at the maximum
        // pairwise displacement inside that window.
        private const val AUTO_PAUSE_RAW_WINDOW_MS = 10_000L
        // Instantaneous speed below which the user is considered stationary.
        // 0.35 m/s ~ 1.26 km/h — a slow shuffle; anything below this is
        // effectively standing still.
        private const val AUTO_PAUSE_SPEED_THRESHOLD_MPS = 0.35f
        // Maximum pairwise displacement within the sliding window below
        // which the user is considered stationary (i.e. not just bouncing
        // in place due to GPS noise). 3.5 m ~ the diameter of a typical
        // urban GPS noise bubble when standing still.
        private const val AUTO_PAUSE_DISPLACEMENT_THRESHOLD_M = 3.5

        // ---- Auto-pause exit hysteresis (CODE_REVIEW_TODO Task 2) ----
        // To prevent the amber "АВТОПАУЗА" banner from flickering on rapid
        // pause/resume oscillation (e.g. very slow walking ~0.3 m/s with
        // small GPS drift can oscillate in and out of auto-pause at the 10 s
        // window boundary), we require N consecutive "clearly moving" fixes
        // before calling exitAutoPause(). A fix counts as "clearly moving"
        // if either:
        //   - pt.speed >= HYSTERESIS_SPEED_MS, OR
        //   - pt.speed is null/0 AND the haversine distance from the last
        //     kept fix implies a velocity >= 1.5 m/s over the dt.
        // A slow fix (< HYSTERESIS_SPEED_MS) resets the counter to 0.
        //
        // The first (MOVING_CONFIRMATION_THRESHOLD - 1) confirmation fixes
        // are dropped (not added to the buffer) so the post-pause segment
        // starts cleanly at the moment resume is confirmed. This loses ~2
        // seconds of track data at each resume — an acceptable trade-off
        // per CODE_REVIEW_TODO Task 2.
        private const val MOVING_CONFIRMATION_THRESHOLD = 3   // consecutive fixes
        private const val HYSTERESIS_SPEED_MS = 0.5f          // 0.5 m/s ≈ slow walk
        private const val HYSTERESIS_DISPLACEMENT_MPS = 1.5   // fallback when speed is null/0
        internal const val KEY_CONSECUTIVE_MOVING_FIXES = "consecutive_moving_fixes"

        // ---- Gap detection (signal loss) (Phase 4) ----
        // If no GPS fix arrives for this many ms, declare a signal gap and
        // split the track into a new <trkseg> when the next fix does arrive.
        private const val GAP_THRESHOLD_MS = 15_000L

        // ---- Auto-pause resume grace window (CODE_REVIEW_TODO Task 1) ----
        // After exitAutoPause(), `lastFixTimeMs` may be stale (last updated
        // while the user was stationary under auto-pause, so it points to a
        // fix that is up to AUTO_PAUSE_RAW_WINDOW_MS old). The gap watchdog
        // (durationTick, 1 Hz) and the gap-recovery branch in onLocationChanged
        // both compare `now - lastFixTimeMs` against GAP_THRESHOLD_MS — if we
        // let them run immediately after resume, they could falsely declare
        // signalLost or trigger a spurious segment split.
        //
        // The grace window suppresses both checks for GAP_THRESHOLD_MS after
        // every exitAutoPause(). exitAutoPause() also refreshes lastFixTimeMs
        // to the resume fix so the watchdog's next tick sees a recent fix
        // even if no further fix arrives.
        //
        // Persisted in the live-state bundle (KEY_AUTO_PAUSE_RESUME_GRACE_UNTIL_MS)
        // so it survives service restart. On recovery, if the grace has
        // already expired (grace < now), it is reset to 0L.
        internal const val KEY_AUTO_PAUSE_RESUME_GRACE_UNTIL_MS = "auto_pause_resume_grace_until_ms"

        // ---- Radial-distance on-the-fly filter (defaults; user-tunable) ----
        // Prefs keys + defaults are owned by GpsRecorderModule, but the
        // service reads them via getRadialDistanceThresholdM(). The defaults
        // here are only used if the prefs file is empty (first launch).

        // ---- Time-sampling on-the-fly filter (defaults; user-tunable) ----

        // ---- Douglas-Peucker post-processing (defaults; user-tunable) ----
        // Epsilon in meters; the service reads it via getDouglasPeuckerEpsilonM().

        // ---- L20: raw-window persistence across service restarts ----
        // Number of trailing raw fixes (from `rawWindow`) to serialize to
        // SharedPreferences so auto-pause detection can make a correct
        // decision on the first fix after a START_STICKY restart. The
        // window is also bounded by AUTO_PAUSE_RAW_WINDOW_MS (10 s); this
        // size cap is the upper bound on how many we'll persist (10 s at
        // 1 Hz = ~10 fixes, which matches).
        internal const val AUTO_PAUSE_RAW_WINDOW_SIZE = 10
        internal const val KEY_RAW_WINDOW = "raw_window"

        // ---- L22: minimum dt for velocity gate ----
        // GPS receivers occasionally emit two fixes within 50–200 ms of
        // each other. A normal 1.4 m/s walk over 100 ms yields 14 m/s,
        // exceeding the 20 km/h ceiling and getting the fix dropped. The
        // velocity gate is bypassed for dt < MIN_VELOCITY_GATE_DT_SEC
        // — the displacement is too small to produce a reliable velocity.
        // dt <= 0 (duplicate timestamp) is still dropped.
        private const val MIN_VELOCITY_GATE_DT_SEC = 0.5

        // ---- L21: reloadPointsFromTempFile abort threshold ----
        // If more than this fraction of points have unparseable
        // timestamps, the reload is aborted entirely (buffer left empty)
        // — better to start a fresh segment than to mix garbage into the
        // timeline.
        private const val RELOAD_BAD_TIMESTAMP_ABORT_FRACTION = 0.1

        // ---- L32: shared SimpleDateFormat instances ----
        // SimpleDateFormat is not thread-safe, but every call site in
        // this service runs on the main thread (location callbacks, tick
        // handlers, lifecycle methods), so a single shared instance per
        // format is safe. If we ever call from a background thread,
        // switch to ThreadLocal.

        // ---- L26: append-only temp file ----
        // Closing tags written at the end of every flush so the temp
        // file is always a complete, parseable GPX document (recoverable
        // on crash). Before appending new points / segment breaks, we
        // truncate these closing tags via RandomAccessFile.setLength.
    }

            private var handler: Handler = Handler(Looper.getMainLooper())

    // Recording state (persisted to SharedPreferences for recovery)
    @Volatile internal var isRecording = false
    internal var startTimeMs: Long = 0L
    @Volatile internal var pointCount: Int = 0
    internal var tempFileName: String? = null

    // Distance accumulator (meters). Persisted so it survives service restarts.
    @Volatile internal var totalDistanceM: Double = 0.0

    // GNSS status tracking (satellites used in current fix).
        @Volatile internal var lastFixTimeMs: Long = 0L
    
    // Previous point used for distance accumulation + velocity-based filtering
    // (Haversine distance and dt between consecutive accepted fixes).
    // Nullified by resetValidationCursor() on auto-pause transitions and
    // gap-recovery events so the next accepted fix isn't validated against
    // a stale previous point.
    @Volatile internal var prevLat: Double? = null
    @Volatile internal var prevLon: Double? = null
    @Volatile internal var prevTimeMs: Long? = null

    // ---- Segmented track buffer (Phase 2) ----
    // Replaces the flat pointBuffer. Each segment corresponds to one
    // <trkseg> in the output GPX. New segments are created on auto-pause
    // transitions and gap-detection events so the final track has clean
    // breaks at those points (no straight-line "stitches" across pauses /
    // gaps). The currently-active segment is `currentSegment`; finalized
    // segments live in `trackSegments`.
    internal val trackSegments = ArrayList<ArrayList<GpsPoint>>()
    @Volatile internal var currentSegment = ArrayList<GpsPoint>()
    internal val pointBufferLock = Any()

    // ---- Auto-pause state (Phase 3) ----
    @Volatile internal var isAutoPaused: Boolean = false
    // Sliding window of the last AUTO_PAUSE_RAW_WINDOW_MS of raw fixes,
    // used to compute displacement for stop detection. Raw = fixes that
    // arrive from onLocationChanged, regardless of whether they passed
    // the on-the-fly filter.
    internal val rawWindow: LinkedList<GpsPoint> = LinkedList()

    // ---- Gap detection state (Phase 4) ----
    // True when the watchdog has declared a signal gap (no fix in
    // GAP_THRESHOLD_MS). Cleared on gap recovery inside onLocationChanged.
    @Volatile internal var signalLost: Boolean = false

    // ---- Moving time accumulator (Phase 6 helper) ----
    // When auto-pause is enabled, this accumulates ONLY the time spent
    // actually moving (i.e. not in isAutoPaused). Used by JS to compute
    // pace based on active moving time instead of wall-clock elapsed time.
    // When auto-pause is disabled, this stays equal to elapsedMs.
    @Volatile internal var movingMs: Long = 0L
    @Volatile internal var lastResumeMs: Long? = null

    // ---- Auto-pause resume grace window (CODE_REVIEW_TODO Task 1) ----
    // While System.currentTimeMillis() < autoPauseResumeGraceUntilMs, the gap
    // watchdog (durationTick) and the gap-recovery branch in onLocationChanged
    // MUST NOT fire. Set by exitAutoPause() to (now + GAP_THRESHOLD_MS) so a
    // stale lastFixTimeMs (left over from when the user was stationary) can't
    // trigger a false signalLost declaration or a spurious segment split in
    // the GAP_THRESHOLD_MS window immediately after resume.
    @Volatile internal var autoPauseResumeGraceUntilMs: Long = 0L

    // ---- Auto-pause exit hysteresis (CODE_REVIEW_TODO Task 2) ----
    // Counts consecutive "clearly moving" fixes while isAutoPaused. When it
    // reaches MOVING_CONFIRMATION_THRESHOLD, exitAutoPause() fires and the
    // counter resets to 0. A slow fix (< HYSTERESIS_SPEED_MS) resets it.
    // Persisted in the live-state bundle so a service restart mid-confirmation
    // doesn't lose progress (the user just has to re-confirm 3 fixes —
    // acceptable per Task 2).
    @Volatile internal var consecutiveMovingFixes: Int = 0

    // ---- Time-sampling on-the-fly filter state ----
    // Monotonic counter incremented for EVERY fix that arrives (after the
    // stale-fix / gap / auto-pause checks). When time_sampling_enabled is
    // on, only fixes where (counter % N == 0) are kept; the rest are
    // dropped before any other gate runs. Reset to 0 in startRecording()
    // so each recording starts a fresh sampling window. Not persisted across
    // service restarts — a restart simply begins a new window.
    @Volatile private var timeSamplingCounter: Int = 0

    // ---- L26: append-only temp-file state ----
    // `tempFileInitialized` becomes true after the first flush writes the
    // GPX header + opening <trk> + first opening <trkseg>. After that,
    // each flush truncates the trailing closing tags and appends only new
    // points + new segment boundaries.
    //
    // `tempFileFlushedSegments` is the count of <trkseg> openings we've
    // written so far (i.e. how many segments — finalized or current — are
    // represented in the file).
    //
    // `tempFileFlushedCurrentSize` is the number of points of the current
    // segment we've already written. Points beyond this index are
    // appended on the next flush.
            
    // Duration tick runnable (1 Hz).
    //
    // L8 fix: emit movingMs alongside elapsedMs on every 1 Hz tick. The JS
    // pace computation uses movingMs when auto-pause / gap detection is on,
    // so previously the displayed avg pace oscillated second-by-second
    // because movingMs was only updated on 'location' events (1 Hz while
    // moving, much less while stationary). With this fix the 'duration'
    // event carries a fresh movingMs every tick — when auto-paused or
    // signal-lost, movingMs stays frozen at its committed value; otherwise
    // it ticks forward in lock-step with elapsedMs (modulo any pauses).
    //
    // L15 fix: the gap-detection watchdog ALSO runs here (1 Hz), not in
    // flushTick (5 s). Previously `signalLost` could fire up to 5 s late,
    // so the real threshold was 15–20 s instead of the "15 с" the UI text
    // claims. Moving the watchdog to a 1 Hz tick makes the threshold truly
    // 15 s, matching the UI. flushTick now only does the temp-file flush
    // (its original purpose).
    private val durationTick = object : Runnable {
        override fun run() {
            if (isRecording) {
                val now = System.currentTimeMillis()
                val elapsed = now - startTimeMs
                val currentMovingMs = if (isAutoPaused || signalLost) {
                    movingMs
                } else {
                    liveMovingMs(now)
                }
                GpsRecorderModule.emitDuration(elapsed, currentMovingMs)

                // Gap watchdog (Phase 4, L15-moved): if no fix in
                // GAP_THRESHOLD_MS, declare signal lost so the UI can show
                // a warning and so the next arriving fix triggers a
                // segment split.
                //
                // Gated on the gap_detection_enabled setting: when the user
                // has disabled gap detection we never declare signalLost
                // (and the segment-split path in onLocationChanged is also
                // bypassed, so the track stays as one continuous segment
                // even across outages — the legacy pre-Phase-4 behaviour).
                //
                // Suppress the watchdog while auto-paused: stationary users
                // legitimately have no incoming fixes (Android throttles
                // updates), so showing the signal-lost banner on top of the
                // auto-pause banner would be contradictory. See CHANGELOG.md.
                //
                // CODE_REVIEW_TODO Task 1: also suppress while inside the
                // auto-pause resume grace window. exitAutoPause() sets
                // autoPauseResumeGraceUntilMs = now + GAP_THRESHOLD_MS and
                // refreshes lastFixTimeMs to the resume fix, but if no
                // further fix arrives in the next 15 s (e.g. the user took
                // one step and then stood still again), the watchdog would
                // see `now - lastFixTimeMs > GAP_THRESHOLD_MS` and falsely
                // declare signalLost. The grace window makes the invariant
                // explicit and refactor-proof.
                if (isGapDetectionEnabled() && !signalLost && !isAutoPaused
                    && now >= autoPauseResumeGraceUntilMs   // Task 1
                    && lastFixTimeMs > 0L) {
                    val sinceLast = now - lastFixTimeMs
                    if (sinceLast > GAP_THRESHOLD_MS) {
                        signalLost = true
                        // Freeze the moving-time accumulator at the time of
                        // the LAST FIX (not "now"), because that's when
                        // movement actually stopped. The GAP_THRESHOLD_MS
                        // window between the last fix and "now" is signal-
                        // loss time and must NOT count as moving time.
                        lastResumeMs?.let { r ->
                            if (lastFixTimeMs > r) movingMs += (lastFixTimeMs - r)
                        }
                        lastResumeMs = null
                        Log.w(TAG, "Signal lost: no fix for ${sinceLast}ms (movingMs frozen at $movingMs)")
                        persistAutoPauseState()
                        notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = pointCount,
                elapsedMs = getElapsedMs(),
                isAutoPaused = isAutoPaused,
                signalLost = signalLost
            )
        )
                        GpsRecorderModule.emitState(
                            isRecording, pointCount, getElapsedMs(),
                            isAutoPaused, signalLost, liveMovingMs(now)
                        )
                    }
                }

                handler.postDelayed(this, 1000L)
            }
        }
    }

    // Periodic flush to temp file (5 s cadence).
    //
    // L15 fix: the gap-detection watchdog was previously in this tick.
    // It has been moved to durationTick (1 Hz) so the signal-lost
    // threshold is truly 15 s instead of 15–20 s. This tick now only
    // does its original job: appending the latest in-memory points to
    // the temp file for crash recovery.
    private val flushTick = object : Runnable {
        override fun run() {
            if (isRecording) {
                tempFileBuffer.flush()
                handler.postDelayed(this, FLUSH_INTERVAL_MS)
            }
        }
    }

    /**
     * A simple POJO for a single GPS fix.
     */

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Service onCreate")
        // Try to recover state in case the service was restarted by the system
        stateRepository.recoverStateIfAny()
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
        // data. Releasing the wakelock. If the system restarts us (START_STICKY),
        // startRecording(resume=true) will re-acquire it. The temp file and
        // SharedPreferences preserve the in-progress recording across the restart.
        if (isRecording) {
            // L25 fix: force a final live-state save before destroy so the
            // throttled saveLiveState doesn't drop the most recent fixes.
            stateRepository.saveLiveState(force = true)
            tempFileBuffer.flush()
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
            // If we were not auto-paused when the service was killed, treat
            // the resume instant as the start of a new moving segment so
            // movingMs accumulates correctly going forward.
            if (!isAutoPaused) {
                lastResumeMs = System.currentTimeMillis()
            }
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
            locationSource.resetSatellites()
            lastFixTimeMs = 0L
            // Phase 2: reset segmented buffer.
            synchronized(pointBufferLock) {
                trackSegments.clear()
                currentSegment = ArrayList()
            }
            // Phase 3/4: reset auto-pause + gap-detection state.
            isAutoPaused = false
            signalLost = false
            rawWindow.clear()
            // Phase 6: reset moving-time accumulator.
            movingMs = 0L
            lastResumeMs = startTimeMs
            // CODE_REVIEW_TODO Task 1: reset the auto-pause resume grace
            // window so a fresh recording doesn't inherit a stale grace
            // from a previous session.
            autoPauseResumeGraceUntilMs = 0L
            // CODE_REVIEW_TODO Task 2: reset the moving-confirmation counter
            // so a fresh recording starts the hysteresis window from 0.
            consecutiveMovingFixes = 0
            // Reset the time-sampling counter so the new recording starts at
            // fix #1 (which is always kept under any N because 1 % N != 0 is
            // false only for N=1; we treat the very first fix specially — see
            // onLocationChanged — so the first fix of a recording is always
            // kept regardless of N).
            timeSamplingCounter = 0
            tempFileName = "gps_temp_${startTimeMs}.gpx"
            tempFileBuffer.tempFileName = tempFileName
            // L25 fix: reset the saveLiveState throttle so the first fix of
            // the new recording is persisted immediately (not skipped by the
            // 5 s throttle).
            stateRepository.resetThrottle()
            // L26 fix: reset the append-only temp-file state. The temp file
            // itself is overwritten in tempFileBuffer.writeGpxHeader() below.
            tempFileBuffer.resetState()  // L26 reset
        }
        isRecording = true

        // Persist state so we can recover after a crash/restart
        stateRepository.persistState()

        // Acquire wakelock so CPU stays awake while screen is off
        wakeLockManager.acquire()

        // Start the foreground notification FIRST (Android requires this within 5s of
        // startForegroundService()).
        notifier.startForegroundIfNeeded(
            GpsRecorderNotification.NotificationSnapshot(
                points = pointCount,
                elapsedMs = getElapsedMs(),
                isAutoPaused = isAutoPaused,
                signalLost = signalLost
            )
        ) {
            wakeLockManager.release()
            GpsRecorderModule.emitError("Не удалось запустить foreground service", fatal = true)
            stopSelf()
        }

        // Start GPS + GNSS status tracking.
        //
        // L1 fix: locationSource.startLocationUpdates() now returns Boolean. If it returns
        // false it has ALREADY called stopRecording() (which finalized state,
        // released the wakelock, emitted state=false, and called stopSelf()).
        // We MUST bail out here without registering the GNSS callback, posting
        // the tick handlers, writing a new temp file header, or emitting
        // state=true — otherwise the UI would flip to "recording" on a
        // service that has already been torn down, and an orphan temp file
        // would be left in externalCacheDir. L5/L6/L7 are all consequences
        // of NOT having this early-return.
        if (!locationSource.startLocationUpdates()) {
            return  // startLocationUpdates already cleaned up via stopRecording()
        }
        locationSource.startGnssStatusTracking()

        // Start duration tick + periodic flush
        handler.post(durationTick)
        handler.postDelayed(flushTick, FLUSH_INTERVAL_MS)

        // Reset temp file content with GPX header (overwrites any stale temp)
        if (!resume) {
            tempFileBuffer.writeGpxHeader()
        }

        GpsRecorderModule.emitState(
            true, pointCount, System.currentTimeMillis() - startTimeMs,
            isAutoPaused, signalLost, liveMovingMs()
        )
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
        locationSource.stopLocationUpdates()
        locationSource.stopGnssStatusTracking()

        // Finalize the moving-time accumulator (add the segment from the
        // last resume up to the LAST FIX to movingMs).
        //
        // Cap the delta at lastFixTimeMs (not "now") so any standing-still
        // time between the last fix and pressing STOP is not counted as
        // moving time. This keeps movingMs consistent with the liveMovingMs
        // value the UI was showing right before STOP. See CHANGELOG.md.
        lastResumeMs?.let { r ->
            val cap = if (lastFixTimeMs > 0L) lastFixTimeMs else System.currentTimeMillis()
            if (cap > r) movingMs += (cap - r)
        }
        lastResumeMs = null

        // L25 fix: force a final live-state save BEFORE finalizeGpxFile so
        // the throttled saveLiveState doesn't drop the most recent fixes / state.
        // The getState() poll and 'saved' event both read from prefs, so this
        // ensures consistency.
        stateRepository.saveLiveState(force = true)

        // Final flush + finalize the GPX file.
        //
        // L5 fix: when the buffer is empty (or no segment has ≥ 2 points),
        // gpxFileSaver.finalizeGpxFile() returns "" — the empty sentinel. In that case we
        // do NOT recompute distance, do NOT emit 'saved' (no 'GPX СОХРАНЁН'
        // toast, no file in Downloads/trck/), and just emit the stopped state.
        val savedFilePath = gpxFileSaver.finalizeGpxFile()
        val savedOk = savedFilePath.isNotEmpty()

        // Recompute the final distance from the SAVED GPX file so the value
        // the user sees in the UI matches the track length they will see when
        // they import the GPX into Strava / another app. This matters most
        // when Gaussian smoothing is on: smoothing pulls each point toward
        // its neighbours, which shortens the track by a few percent vs. the
        // raw live-accumulated haversine distance. Without this recompute,
        // the UI would show e.g. 5.12 km while the GPX file's true length is
        // 4.98 km — exactly the kind of "distance is weird" complaint that
        // prompted this fix.
        //
        // We parse the saved GPX directly (rather than re-reading the in-
        // memory segments) so we capture whatever smoothing / filtering was
        // applied at finalize time. On failure we fall back to -1.0, which
        // the JS side interprets as "keep the live-accumulated distance".
        val finalDistanceM = if (savedOk) gpxFileSaver.recomputeDistanceFromSavedGpx(savedFilePath) else -1.0

        // Clear persisted state
        stateRepository.clearPersistedState()

        // Release wakelock
        wakeLockManager.release()

        // Tell JS (if alive) that we saved a file. Include the final distance
        // so the UI can show the post-save, post-smoothing track length
        // instead of the live-accumulated value.
        //
        // L5 fix: only emit 'saved' when we actually wrote a file. The empty
        // sentinel means gpxFileSaver.finalizeGpxFile() bailed out early because the buffer
        // was empty — emitting a 'saved' event in that case would make the UI
        // flash a 'GPX СОХРАНЁН' card with no real file behind it.
        if (savedOk) {
            GpsRecorderModule.emitSaved(savedFilePath, pointCount, finalDistanceM)
        }
        GpsRecorderModule.emitState(false, 0, 0L, false, false, 0L)

        // Stop foreground + service
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ------------------------------------------------------------------
    // Foreground notification
    // ------------------------------------------------------------------






    /**
     * Starts location updates from the available providers.
     *
     * Returns `true` if updates were successfully requested (or at least one
     * provider was attempted without a hard failure). Returns `false` if a
     * precondition failed — in that case this method has ALREADY called
     * [stopRecording] (which finalizes any state, releases the wakelock, and
     * calls [stopSelf]) and the caller MUST bail out immediately without
     * touching any further recording state (GNSS callback registration, tick
     * handlers, temp file header, emit-state-true, etc.).
     *
     * This return-value contract is the fix for the L1 bug where
     * `startRecording()` kept going after `stopRecording()` had already torn
     * the service down, leaving the UI showing "recording" on a stopped
     * service and an orphan temp file in `externalCacheDir`.
     */


    // ------------------------------------------------------------------
    // GNSS status (satellite count for fix-type display)
    // ------------------------------------------------------------------



    // ------------------------------------------------------------------
    // Phase 2/3/4: segmented buffer, auto-pause, gap-detection helpers
    // ------------------------------------------------------------------

    /**
     * Finalizes the current segment (if non-empty) and starts a new, empty
     * one. Called on auto-pause transitions and gap-recovery events so the
     * track has clean <trkseg> breaks at those points (no straight-line
     * "stitches" across pauses / gaps).
     *
     * Safe to call when currentSegment is already empty — it is a no-op in
     * that case.
     */
    private fun createNewSegment() {
        synchronized(pointBufferLock) {
            if (currentSegment.isNotEmpty()) {
                trackSegments.add(currentSegment)
                currentSegment = ArrayList()
            }
        }
    }

    /**
     * Nullifies the prev-fix cursor used by the velocity / distance gates.
     * Called on auto-pause transitions and gap-recovery events so the next
     * accepted fix isn't validated against a stale previous point (which
     * would either be dropped by the velocity gate or inflate the distance
     * with a straight-line jump across the pause / gap).
     */
    private fun resetValidationCursor() {
        prevLat = null
        prevLon = null
        prevTimeMs = null
    }

    /**
     * Returns the total number of points across all finalized segments plus
     * the currently-active segment. This is the value reported to JS as
     * `pointCount`.
     */
    internal fun totalPointCount(): Int = synchronized(pointBufferLock) {
        var n = currentSegment.size
        for (seg in trackSegments) n += seg.size
        n
    }

    /**
     * Returns a snapshot of all segments (finalized + current) for serialization.
     * Each inner list is one <trkseg>.
     */
    internal fun segmentsSnapshot(): List<List<GpsPoint>> = synchronized(pointBufferLock) {
        val out = ArrayList<List<GpsPoint>>(trackSegments.size + 1)
        for (seg in trackSegments) out.add(ArrayList(seg))
        out.add(ArrayList(currentSegment))
        out
    }

    /**
     * Adds a point to the currently-active segment and refreshes [pointCount].
     * Caller must have already validated the point (accuracy / velocity gates,
     * auto-pause / gap detection, etc.).
     */
    private fun appendPointToCurrentSegment(pt: GpsPoint) {
        synchronized(pointBufferLock) {
            currentSegment.add(pt)
            pointCount = currentSegment.size + trackSegments.sumOf { it.size }
        }
    }

    /**
     * Returns the maximum pairwise Haversine distance (in meters) between
     * any two points in the sliding raw window. Used by auto-pause to confirm
     * that the user is actually standing still (and not just momentarily
     * slow at the start of a sprint).
     *
     * O(n^2) in the window size — at 1 Hz over 10 s that's ~45 comparisons,
     * which is negligible.
     */
    private fun maxDisplacementInWindow(): Double {
        // Take a snapshot under no lock (rawWindow is only touched on the
        // main thread by onLocationChanged, so this is safe).
        val pts = ArrayList(rawWindow)
        if (pts.size < 2) return 0.0
        var maxD = 0.0
        for (i in pts.indices) {
            val a = pts[i]
            for (j in (i + 1) until pts.size) {
                val b = pts[j]
                val d = TrackMath.haversineMeters(a.lat, a.lon, b.lat, b.lon)
                if (d > maxD) maxD = d
            }
        }
        return maxD
    }

    /**
     * Reads the auto-pause setting from the SEPARATE settings prefs file.
     * The setting is written by GpsRecorderModule.setAutoPauseEnabled() from JS.
     * Stored apart from `gps_recorder_state` so it survives the per-recording
     * state clear in stopRecording().
     */
    private fun isAutoPauseEnabled(): Boolean = GpsRecorderSettings.isAutoPauseEnabled(this)

    /**
     * Reads the gap-detection setting from the SEPARATE settings prefs file.
     * When enabled (default), the gap watchdog in [flushTick] declares
     * signalLost after GAP_THRESHOLD_MS without a fix, and the next arriving
     * fix triggers a segment split so the track has clean <trkseg> breaks at
     * signal outages. When disabled, gaps are NOT detected: the timer keeps
     * running across the outage, the next fix is appended to the same
     * segment, and the velocity gate will compare it against the pre-gap
     * point (which may produce a velocity outlier that gets dropped, or a
     * straight-line jump that gets added to totalDistanceM — the legacy
     * behaviour before gap detection existed).
     *
     * The setting is written by GpsRecorderModule.setGapDetectionEnabled()
     * from JS and survives the per-recording state clear.
     */
    private fun isGapDetectionEnabled(): Boolean = GpsRecorderSettings.isGapDetectionEnabled(this)

    /**
     * Persists the auto-pause / signal-lost / moving-time live state to
     * SharedPreferences so it survives service restarts and can be polled
     * via getState(). Called whenever these flags change (whether or not a
     * new fix arrived).
     */
    private fun persistAutoPauseState() {
        try {
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_IS_AUTO_PAUSED, isAutoPaused)
                .putBoolean(KEY_SIGNAL_LOST, signalLost)
                .putLong(KEY_MOVING_MS, movingMs)
                // CODE_REVIEW_TODO Task 1: persist the grace window here too
                // so a service restart mid-grace still honors it.
                .putLong(KEY_AUTO_PAUSE_RESUME_GRACE_UNTIL_MS, autoPauseResumeGraceUntilMs)
                // CODE_REVIEW_TODO Task 2: persist the moving-confirmation
                // counter so a service restart mid-confirmation doesn't
                // lose progress.
                .putInt(KEY_CONSECUTIVE_MOVING_FIXES, consecutiveMovingFixes)
                .apply()
        } catch (e: Exception) {
            Log.w(TAG, "persistAutoPauseState failed", e)
        }
    }

    /**
     * Enters auto-pause: stops recording points, finalizes the current
     * segment so the post-pause segment is distinct, freezes the moving-time
     * accumulator, and updates the foreground notification.
     *
     * Also clears `signalLost`: stationary users legitimately have no
     * incoming fixes, so showing the signal-lost banner on top of the
     * auto-pause banner would be contradictory. See CHANGELOG.md.
     */
    private fun enterAutoPause(now: Long) {
        isAutoPaused = true
        signalLost = false
        resetValidationCursor()
        createNewSegment()
        // Freeze the moving-time accumulator.
        lastResumeMs?.let { r ->
            if (now > r) movingMs += (now - r)
        }
        lastResumeMs = null
        // CODE_REVIEW_TODO Task 2: reset the moving-confirmation counter so
        // the next resume requires a fresh run of MOVING_CONFIRMATION_THRESHOLD
        // consecutive fast fixes.
        consecutiveMovingFixes = 0
        persistAutoPauseState()
        notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = pointCount,
                elapsedMs = getElapsedMs(),
                isAutoPaused = isAutoPaused,
                signalLost = signalLost
            )
        )
        Log.i(TAG, "Auto-pause entered at $now (movingMs=$movingMs)")
    }

    /**
     * Returns the *live* moving time up to [now]: the committed [movingMs]
     * plus any time accumulated since [lastResumeMs] when the user is
     * actively moving (not auto-paused and not signal-lost).
     *
     * Bugfix for the "average pace tends to go off" issue: previously the
     * `movingMs` field was only ever updated at auto-pause transitions
     * (enterAutoPause / exitAutoPause / stopRecording). Between transitions
     * while the user was actively walking, the value the UI saw was frozen
     * at whatever the last transition had committed — which could be many
     * minutes stale. That made `computeAvgPace(movingMs, distance)` produce
     * absurd values like 0:02/km early in a walk (frozen at 0) or 6:20/km
     * 40 minutes in (frozen at the value committed at the last brief
     * auto-pause, 18 minutes earlier).
     *
     * With this helper, every emit / save / state-poll path returns the
     * true up-to-the-second moving time, so the displayed avg pace tracks
     * the actual walk in real time.
     */
    internal fun liveMovingMs(now: Long = System.currentTimeMillis()): Long {
        if (isAutoPaused || signalLost) return movingMs
        val r = lastResumeMs ?: return movingMs
        val delta = now - r
        return if (delta > 0L) movingMs + delta else movingMs
    }

    /**
     * Exits auto-pause: starts a new segment for the post-pause data,
     * resets the validation cursor so the first post-pause fix isn't dropped
     * by the velocity gate, and resumes the moving-time accumulator.
     *
     * CODE_REVIEW_TODO Task 1: also sets a "just resumed from auto-pause"
     * grace window of GAP_THRESHOLD_MS during which the gap watchdog and the
     * gap-recovery branch MUST NOT fire. Without this, the watchdog's next
     * 1 Hz tick could compare `now - lastFixTimeMs` against GAP_THRESHOLD_MS
     * using a stale `lastFixTimeMs` (last updated while the user was
     * stationary) and falsely declare signalLost — see CHANGELOG.md /
     * CODE_REVIEW_TODO Task 1 for the full race scenario.
     *
     * We also refresh `lastFixTimeMs` to the resume fix timestamp so the
     * watchdog's next tick sees a recent fix even if no further fix arrives
     * in the next 15 s (e.g. the user takes one step and then stands still
     * again — the auto-pause path will re-engage via enterAutoPause() before
     * the grace window expires, but if it doesn't, the watchdog should still
     * not fire falsely).
     */
    private fun exitAutoPause(now: Long) {
        isAutoPaused = false
        resetValidationCursor()
        createNewSegment()  // no-op if currentSegment is empty (typical case)
        lastResumeMs = now
        // CODE_REVIEW_TODO Task 1: grace window + lastFixTimeMs refresh.
        autoPauseResumeGraceUntilMs = now + GAP_THRESHOLD_MS
        lastFixTimeMs = now
        // CODE_REVIEW_TODO Task 2: reset the moving-confirmation counter so
        // the next auto-pause cycle starts fresh.
        consecutiveMovingFixes = 0
        persistAutoPauseState()
        notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = pointCount,
                elapsedMs = getElapsedMs(),
                isAutoPaused = isAutoPaused,
                signalLost = signalLost
            )
        )
        Log.i(TAG, "Auto-pause exited at $now (movingMs=$movingMs, graceUntil=$autoPauseResumeGraceUntilMs)")
    }

    /**
     * Handles gap recovery: called inside onLocationChanged when a new fix
     * arrives after a signal gap (> GAP_THRESHOLD_MS since the last fix, or
     * when the watchdog has already declared signalLost). Splits the track
     * into a new segment and resets the validation cursor so the velocity
     * gate doesn't compare across the gap. Distance across the gap is NOT
     * added to totalDistanceM (prevLat is null after reset).
     *
     * Also resumes the moving-time accumulator from `now`. While the gap
     * was active the watchdog froze movingMs (see [flushTick]); now that a
     * fix has arrived we resume accumulating. If the user is actually
     * stationary, the auto-pause path further down in onLocationChanged
     * will immediately re-freeze movingMs via enterAutoPause(), so this is
     * safe. See CHANGELOG.md.
     */
    private fun handleGapRecovery(now: Long) {
        resetValidationCursor()
        createNewSegment()
        signalLost = false
        // Resume moving-time accumulation from this instant. If the user
        // is stationary, the auto-pause path below will immediately freeze
        // it again via enterAutoPause(now) — net effect: zero gap time
        // leaks into movingMs, and a stationary post-gap user still gets
        // correctly auto-paused.
        lastResumeMs = now
        persistAutoPauseState()
        notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = pointCount,
                elapsedMs = getElapsedMs(),
                isAutoPaused = isAutoPaused,
                signalLost = signalLost
            )
        )
        Log.i(TAG, "Gap recovered at $now — new segment started, movingMs accumulation resumed")
    }

    // ------------------------------------------------------------------
    // GPS callback
    // ------------------------------------------------------------------

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
            // L33 fix: downgrade to SafeLog.d and strip lat/lon — this was
            // the only Log.w call in the service that leaked GPS coordinates
            // in release builds.
            SafeLog.d(TAG, "Dropping stale fix: age=${fixAgeMs}ms")
            return
        }

        // ---- Phase 4: Gap detection (signal loss) ----
        // If this fix arrived more than GAP_THRESHOLD_MS after the previous one,
        // OR if the watchdog has already declared signalLost, treat this as gap
        // recovery: split the track into a new segment and reset the validation
        // cursor so the velocity gate doesn't compare across the gap. Distance
        // across the gap is NOT added to totalDistanceM (prevLat is null after
        // reset, so both the velocity gate and accumulateDistance skip it).
        //
        // Gated on the gap_detection_enabled setting. When the user has
        // disabled gap detection, we skip the segment-split entirely (the
        // next fix is appended to the current segment, and the velocity
        // gate will compare it against the pre-gap point — the legacy pre-
        // Phase-4 behaviour). signalLost can only be true at this point if
        // the watchdog declared it while the setting was on, so even when
        // the setting has just been toggled off mid-recording we still
        // honor a previously-declared signalLost by clearing it without
        // splitting the segment.
        //
        // Skip this block while auto-paused: stationary users have no
        // incoming fixes by design, and the current segment was already
        // finalized on auto-pause entry. Running handleGapRecovery here
        // would create spurious 1-point segments in the GPX. See CHANGELOG.md.
        //
        // CODE_REVIEW_TODO Task 1: also skip while inside the auto-pause
        // resume grace window. The resume fix itself arrives with
        // isAutoPaused already flipped to false (exitAutoPause ran earlier
        // in this same onLocationChanged call), so without the grace check
        // this branch would compare `pt.timeMs - lastFixTimeMs` (which
        // exitAutoPause just refreshed to `pt.timeMs`, so the diff is 0)
        // — but on the NEXT fix, if the user stood still for ~25 s before
        // resuming, lastFixTimeMs may still point to a stale pre-pause
        // value and the diff would exceed GAP_THRESHOLD_MS, falsely
        // triggering a segment split. The grace check makes the invariant
        // explicit.
        if (isGapDetectionEnabled() && !isAutoPaused
            && pt.timeMs >= autoPauseResumeGraceUntilMs   // Task 1
        ) {
            val gapDetected = lastFixTimeMs > 0L && (pt.timeMs - lastFixTimeMs) > GAP_THRESHOLD_MS
            if (gapDetected || signalLost) {
                Log.i(
                    TAG,
                    "Gap recovery: gapSinceLast=${if (lastFixTimeMs > 0L) pt.timeMs - lastFixTimeMs else -1}ms" +
                        " signalLostWas=$signalLost"
                )
                handleGapRecovery(pt.timeMs)
            }
        } else if (signalLost) {
            // Setting was toggled off after the watchdog declared signalLost,
            // OR we're auto-paused (in which case the watchdog should not have
            // fired — but be defensive). Clear the flag without splitting the
            // segment so the UI banner dismisses itself, but the track keeps
            // its current segment structure.
            signalLost = false
            persistAutoPauseState()
            notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = pointCount,
                elapsedMs = getElapsedMs(),
                isAutoPaused = isAutoPaused,
                signalLost = signalLost
            )
        )
            Log.i(TAG, "Gap detection disabled or auto-paused — clearing signalLost flag")
        }

        // ---- Phase 3: Auto-pause (stop detection) ----
        // When enabled, we maintain a sliding window of the last
        // AUTO_PAUSE_RAW_WINDOW_MS of raw fixes and check two conditions:
        //   1. Instantaneous speed < AUTO_PAUSE_SPEED_THRESHOLD_MPS
        //   2. Maximum pairwise displacement in the window < AUTO_PAUSE_DISPLACEMENT_THRESHOLD_M
        // If both are true, the user is considered stationary; we enter (or
        // stay in) auto-pause and skip recording the point. When the user
        // starts moving again, we exit auto-pause and start a new segment.
        if (isAutoPauseEnabled()) {
            // Push to sliding raw window and prune entries older than the window.
            rawWindow.add(pt)
            val windowCutoff = pt.timeMs - AUTO_PAUSE_RAW_WINDOW_MS
            while (rawWindow.isNotEmpty() && rawWindow.peek().timeMs < windowCutoff) {
                rawWindow.poll()
            }

            // L11 fix: do NOT treat a missing speed as 'stationary'. When
            // Location.hasSpeed() is false (cold start, poor signal, some
            // devices / emulators), pt.speed is null. The previous code
            // coerced it to 0f, which made speedOk = true (stationary) and
            // contributed to false auto-pause triggers even while the user
            // was moving. We now treat a null speed as 'not stationary' so
            // the displacement check (line below) is the sole backstop —
            // exactly what we want when the GPS can't tell us our speed.
            val speedOk = pt.speed?.let { it < AUTO_PAUSE_SPEED_THRESHOLD_MPS } ?: false
            val disp = maxDisplacementInWindow()
            val dispOk = disp < AUTO_PAUSE_DISPLACEMENT_THRESHOLD_M
            val stopped = speedOk && dispOk

            if (stopped) {
                // User is stationary.
                if (!isAutoPaused) {
                    Log.i(
                        TAG,
                        "Auto-pause entering: speed=${pt.speed} disp=${disp}m window=${rawWindow.size}"
                    )
                    enterAutoPause(pt.timeMs)
                }
                // CODE_REVIEW_TODO Task 2: a stationary fix while paused
                // resets the moving-confirmation counter (the user has to
                // re-accumulate MOVING_CONFIRMATION_THRESHOLD consecutive
                // fast fixes to resume). enterAutoPause() also resets it,
                // but we reset here too so a slow fix during the
                // confirmation window — without re-entering pause — also
                // resets the counter.
                if (isAutoPaused) consecutiveMovingFixes = 0
                // While paused: do NOT add the point to the buffer and do NOT
                // accumulate distance. But DO update lastFixTimeMs and live
                // state so the UI knows we still have a fix (and isn't fooled
                // into thinking we lost signal).
                lastFixTimeMs = pt.timeMs
                stateRepository.saveLiveState(pt)
                GpsRecorderModule.emitLocation(
                    pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                    locationSource.computeFixType(lastFixTimeMs), totalDistanceM, pt.timeMs, pointCount,
                    isAutoPaused, signalLost, liveMovingMs(pt.timeMs)
                )
                return
            } else {
                // User is moving.
                if (isAutoPaused) {
                    // CODE_REVIEW_TODO Task 2: hysteresis — require
                    // MOVING_CONFIRMATION_THRESHOLD consecutive "clearly
                    // moving" fixes before resuming. This prevents the
                    // amber "АВТОПАУЗА" banner from flickering on rapid
                    // pause/resume oscillation (e.g. very slow walking
                    // ~0.3 m/s with GPS drift can oscillate at the 10 s
                    // window boundary). Each flicker creates a new <trkseg>
                    // and toggles the notification / banner — technically
                    // correct but feels glitchy.
                    //
                    // A fix counts as "clearly moving" if EITHER:
                    //   - pt.speed >= HYSTERESIS_SPEED_MS (primary), OR
                    //   - pt.speed is null/0 AND haversine displacement
                    //     from the last kept fix implies velocity >=
                    //     HYSTERESIS_DISPLACEMENT_MPS (fallback for
                    //     receivers that don't populate Location.speed).
                    //
                    // The first (MOVING_CONFIRMATION_THRESHOLD - 1)
                    // confirmation fixes are dropped (same pattern as the
                    // stopped branch above) so the post-pause segment
                    // starts cleanly at the moment resume is confirmed.
                    // This loses ~2 s of track data at each resume —
                    // acceptable per Task 2.
                    val speedBased = pt.speed != null && pt.speed >= HYSTERESIS_SPEED_MS
                    val dispBased = (!speedBased && (pt.speed == null || pt.speed == 0f)) && run {
                        val pLat = prevLat
                        val pLon = prevLon
                        val pTime = prevTimeMs
                        if (pLat != null && pLon != null && pTime != null) {
                            val dtSec = (pt.timeMs - pTime) / 1000.0
                            if (dtSec > 0) {
                                val d = TrackMath.haversineMeters(pLat, pLon, pt.lat, pt.lon)
                                (d / dtSec) >= HYSTERESIS_DISPLACEMENT_MPS
                            } else false
                        } else false
                    }
                    if (speedBased || dispBased) {
                        consecutiveMovingFixes++
                        if (consecutiveMovingFixes >= MOVING_CONFIRMATION_THRESHOLD) {
                            Log.i(
                                TAG,
                                "Auto-pause resuming after $consecutiveMovingFixes confirmation fixes:" +
                                    " speed=${pt.speed} disp=${disp}m window=${rawWindow.size}"
                            )
                            exitAutoPause(pt.timeMs)
                            // ← fall through; this fix is added to the new
                            // post-resume segment (exitAutoPause called
                            // createNewSegment above).
                        } else {
                            // Confirmation in progress — still auto-paused.
                            // Drop the fix (same pattern as the stopped
                            // branch) so the buffer stays clean until the
                            // resume is confirmed. The UI still gets the
                            // location event so the user sees their
                            // current position update.
                            Log.i(
                                TAG,
                                "Auto-pause confirmation $consecutiveMovingFixes/$MOVING_CONFIRMATION_THRESHOLD:" +
                                    " speed=${pt.speed} disp=${disp}m — staying paused"
                            )
                            lastFixTimeMs = pt.timeMs
                            stateRepository.saveLiveState(pt)
                            GpsRecorderModule.emitLocation(
                                pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                                locationSource.computeFixType(lastFixTimeMs), totalDistanceM, pt.timeMs, pointCount,
                                isAutoPaused, signalLost, liveMovingMs(pt.timeMs)
                            )
                            return
                        }
                    } else {
                        // User moved a little but not clearly enough to
                        // count toward resume confirmation. Reset the
                        // counter and stay paused. Drop the fix.
                        if (consecutiveMovingFixes > 0) {
                            Log.i(
                                TAG,
                                "Auto-pause confirmation reset (was $consecutiveMovingFixes):" +
                                    " speed=${pt.speed} disp=${disp}m — staying paused"
                            )
                        }
                        consecutiveMovingFixes = 0
                        lastFixTimeMs = pt.timeMs
                        stateRepository.saveLiveState(pt)
                        GpsRecorderModule.emitLocation(
                            pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                            locationSource.computeFixType(lastFixTimeMs), totalDistanceM, pt.timeMs, pointCount,
                            isAutoPaused, signalLost, liveMovingMs(pt.timeMs)
                        )
                        return
                    }
                }
            }
        }

        // The "post_process_enabled" setting is now interpreted as ON-THE-FLY track
        // filtering: when it is on, noisy / wild points are dropped at write time
        // so the GPX buffer only ever contains clean, validated fixes and there is
        // nothing left to post-process at finalization. When it is off, every fix
        // is recorded raw (the fallback / diagnostic mode).
        //
        // ---- Time-sampling on-the-fly filter (independent toggle) ----
        // Keep every N-th fix; drop the rest. The dropped fix is still "fresh"
        // (it's a good GPS fix, just denser than the user wants), so we update
        // lastFixTimeMs + saveLiveState + emit before returning. This keeps the
        // UI's lastFix display current and prevents the gap watchdog from
        // falsely firing (since lastFixTimeMs advances on every fix, kept or
        // dropped).
        //
        // The counter is reset to 0 in startRecording() and incremented for
        // every fix that reaches this point. The first fix of a recording
        // (counter == 1 after the increment below) is ALWAYS kept so the
        // track has a starting point even when N > 1.
        if (isTimeSamplingEnabled()) {
            timeSamplingCounter++
            val n = getTimeSamplingN().coerceAtLeast(1)
            val keep = (n == 1) || (timeSamplingCounter == 1) || (timeSamplingCounter % n == 0)
            if (!keep) {
                SafeLog.d(TAG, "Time sampling: dropping fix #${timeSamplingCounter} (n=$n)")
                lastFixTimeMs = pt.timeMs
                stateRepository.saveLiveState(pt)
                GpsRecorderModule.emitLocation(
                    pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                    locationSource.computeFixType(lastFixTimeMs), totalDistanceM, pt.timeMs, pointCount,
                    isAutoPaused, signalLost, liveMovingMs(pt.timeMs)
                )
                notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = pointCount,
                elapsedMs = getElapsedMs(),
                isAutoPaused = isAutoPaused,
                signalLost = signalLost
            )
        )
                return
            }
        }

        if (isPostProcessEnabled()) {
            // B. Accuracy gate: skip fixes whose reported accuracy is worse than the
            // threshold. These are almost always multipath or cold-start noise.
            //
            // L4 fix: dropped fixes MUST still advance lastFixTimeMs, save live
            // state, and emit a location event — same pattern the time-sampling
            // drop (above) and the radial filter drop (below) use. Without this
            // the UI's lastFix display freezes for the dropped fix, the gap
            // watchdog falsely fires 'signalLost' after 15 s of dropped fixes,
            // and getState() polling returns stale data.
            //
            // We do NOT advance prevLat/prevLon — these are dropped fixes and
            // must not become the reference for the next fix's velocity /
            // distance computation.
            val acc = pt.accuracy
            if (acc != null && acc > ACCURACY_THRESHOLD_M) {
                SafeLog.d(TAG, "On-the-fly filter: dropping low-accuracy fix (acc=${acc}m)")
                lastFixTimeMs = pt.timeMs
                stateRepository.saveLiveState(pt)
                GpsRecorderModule.emitLocation(
                    pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                    locationSource.computeFixType(lastFixTimeMs), totalDistanceM, pt.timeMs, pointCount,
                    isAutoPaused, signalLost, liveMovingMs(pt.timeMs)
                )
                notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = pointCount,
                elapsedMs = getElapsedMs(),
                isAutoPaused = isAutoPaused,
                signalLost = signalLost
            )
        )
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
            //
            // L22 fix: a sub-half-second dt (50–200 ms) bypasses the velocity
            // gate entirely. Some GPS receivers emit clustered fixes with
            // very small dt; a normal 1.4 m/s walk over 100 ms yields 14 m/s,
            // which would exceed the 20 km/h ceiling and get the fix dropped
            // even though it's a legitimate walking point. The displacement
            // is too small to produce a reliable velocity, so we accept the
            // fix without a velocity check. dt <= 0 (duplicate timestamp) is
            // still dropped.
            //
            // NOTE: prevLat is null after a resetValidationCursor() call (auto-
            // pause resume / gap recovery), so this gate is naturally bypassed
            // for the first fix after such a transition — exactly what we want,
            // since that fix has no meaningful "previous" to compare against.
            //
            // L4 fix (see accuracy gate above): the zero-dt and velocity drops
            // also mirror the time-sampling drop pattern so the UI stays fresh
            // and the gap watchdog doesn't fire falsely.
            var distanceToAdd = 0.0
            val pLat = prevLat
            val pLon = prevLon
            val pTime = prevTimeMs
            if (pLat != null && pLon != null && pTime != null) {
                val dtSec = (pt.timeMs - pTime) / 1000.0
                if (dtSec <= 0.0) {
                    SafeLog.d(TAG, "On-the-fly filter: dropping zero-dt fix (dt=${dtSec}s)")
                    lastFixTimeMs = pt.timeMs
                    stateRepository.saveLiveState(pt)
                    GpsRecorderModule.emitLocation(
                        pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                        locationSource.computeFixType(lastFixTimeMs), totalDistanceM, pt.timeMs, pointCount,
                        isAutoPaused, signalLost, liveMovingMs(pt.timeMs)
                    )
                    notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = pointCount,
                elapsedMs = getElapsedMs(),
                isAutoPaused = isAutoPaused,
                signalLost = signalLost
            )
        )
                    return
                }
                val d = TrackMath.haversineMeters(pLat, pLon, pt.lat, pt.lon)
                if (dtSec >= MIN_VELOCITY_GATE_DT_SEC) {
                    val velocityMps = d / dtSec
                    if (velocityMps > MAX_VELOCITY_MPS) {
                        SafeLog.d(TAG, "On-the-fly filter: dropping velocity outlier (v=${velocityMps}m/s d=${d}m dt=${dtSec}s)")
                        lastFixTimeMs = pt.timeMs
                        stateRepository.saveLiveState(pt)
                        GpsRecorderModule.emitLocation(
                            pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                            locationSource.computeFixType(lastFixTimeMs), totalDistanceM, pt.timeMs, pointCount,
                            isAutoPaused, signalLost, liveMovingMs(pt.timeMs)
                        )
                        notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = pointCount,
                elapsedMs = getElapsedMs(),
                isAutoPaused = isAutoPaused,
                signalLost = signalLost
            )
        )
                        return
                    }
                }
                distanceToAdd = d
                // ---- Radial-distance on-the-fly filter (independent toggle) ----
                // Drops the candidate if it is closer than threshold meters to
                // the last KEPT point (which is what prevLat/prevLon currently
                // point to — they only advance after a fix is appended below).
                // This is independent of the accuracy / velocity gate above; it
                // can be enabled on its own to suppress stationary GPS jitter
                // that the velocity gate considers plausible (e.g. the user
                // standing still and the GPS drifting around within a 3 m
                // radius at ~0.3 m/s — below the 0.35 m/s auto-pause threshold
                // but well within the 20 km/h velocity ceiling).
                //
                // We re-use the haversine distance `d` already computed above so
                // we don't pay for a second haversine call. The dropped fix is
                // still "fresh" (good GPS), so we update lastFixTimeMs +
                // saveLiveState + emit before returning — same pattern as the
                // time-sampling drop above.
                //
                // Stage distanceToAdd in a local and only commit to
                // totalDistanceM *after* the radial filter check passes, so
                // the cursor and the accumulator always advance together
                // (otherwise dropped fixes would double-count their step
                // distance). See CHANGELOG.md.
                if (isRadialDistanceFilterEnabled()) {
                    val threshold = getRadialDistanceThresholdM().toDouble()
                    if (d < threshold) {
                        SafeLog.d(TAG, "Radial filter: dropping too-close fix (d=${d}m < ${threshold}m)")
                        lastFixTimeMs = pt.timeMs
                        stateRepository.saveLiveState(pt)
                        GpsRecorderModule.emitLocation(
                            pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                            locationSource.computeFixType(lastFixTimeMs), totalDistanceM, pt.timeMs, pointCount,
                            isAutoPaused, signalLost, liveMovingMs(pt.timeMs)
                        )
                        notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = pointCount,
                elapsedMs = getElapsedMs(),
                isAutoPaused = isAutoPaused,
                signalLost = signalLost
            )
        )
                        return
                    }
                }
            }
            // D. Point passed both gates — commit it to the current segment and
            // advance the previous-fix cursor.
            // Accumulate only after confirming the point passes the radial
            // filter, so dropped fixes don't leak distance into totalDistanceM.
            totalDistanceM += distanceToAdd
            appendPointToCurrentSegment(pt)
            prevLat = pt.lat
            prevLon = pt.lon
            prevTimeMs = pt.timeMs
            lastFixTimeMs = pt.timeMs
        } else {
            // ---- Radial-distance on-the-fly filter (raw mode) ----
            // Same logic as in the post_process branch above, but we have to
            // compute the haversine ourselves because the velocity gate runs
            // inside accumulateDistance() and we don't have a `d` in scope.
            // We check against prevLat (last KEPT point) before appending.
            //
            // L29 fix: when the radial filter is enabled, we compute `d` here
            // and pass it to accumulateDistance() via the new
            // `precomputedDistanceM` parameter — eliminating the duplicate
            // haversine call that the previous version made inside
            // accumulateDistance(). When the radial filter is disabled, we
            // pass null and let accumulateDistance() compute `d` itself.
            var precomputedD: Double? = null
            if (isRadialDistanceFilterEnabled()) {
                val pLat = prevLat
                val pLon = prevLon
                if (pLat != null && pLon != null) {
                    val d = TrackMath.haversineMeters(pLat, pLon, pt.lat, pt.lon)
                    precomputedD = d
                    val threshold = getRadialDistanceThresholdM().toDouble()
                    if (d < threshold) {
                        SafeLog.d(TAG, "Radial filter (raw): dropping too-close fix (d=${d}m < ${threshold}m)")
                        lastFixTimeMs = pt.timeMs
                        stateRepository.saveLiveState(pt)
                        GpsRecorderModule.emitLocation(
                            pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                            locationSource.computeFixType(lastFixTimeMs), totalDistanceM, pt.timeMs, pointCount,
                            isAutoPaused, signalLost, liveMovingMs(pt.timeMs)
                        )
                        notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = pointCount,
                elapsedMs = getElapsedMs(),
                isAutoPaused = isAutoPaused,
                signalLost = signalLost
            )
        )
                        return
                    }
                }
            }
            // E. Fallback: record every fix raw so the GPX file keeps the noisy
            // data, but still keep the displayed distance sane by routing the
            // accuracy/velocity gates through the distance accumulator only.
            appendPointToCurrentSegment(pt)
            accumulateDistance(pt, precomputedD)
            lastFixTimeMs = pt.timeMs
        }
        // Save current state to SharedPreferences so JS can poll via getState()
        // even if the event emitter is not delivering events reliably.
        stateRepository.saveLiveState(pt)
        // Emit the event with pointCount + auto-pause / signal state so the JS
        // UI can reflect pause / gap status in real time.
        //
        // Emit liveMovingMs(pt.timeMs): the frozen movingMs field is only
        // updated at auto-pause transitions, so between transitions it would
        // make the displayed avg pace wildly off. liveMovingMs adds the time
        // elapsed since the last resume so the value tracks the actual walk
        // second-by-second. See CHANGELOG.md.
        GpsRecorderModule.emitLocation(
            pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
            locationSource.computeFixType(lastFixTimeMs), totalDistanceM, pt.timeMs, pointCount,
            isAutoPaused, signalLost, liveMovingMs(pt.timeMs)
        )
        notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = pointCount,
                elapsedMs = getElapsedMs(),
                isAutoPaused = isAutoPaused,
                signalLost = signalLost
            )
        )
    }

    /**
     * Adds the Haversine distance between [pt] and the previous accepted fix to
     * [totalDistanceM]. Filters out fixes with poor accuracy or implausible
     * velocity (walk/run ceiling 20 km/h) to avoid GPS noise inflating the
     * distance. This is the path used when on-the-fly filtering is OFF (raw
     * recording) — the point itself is still added to the buffer (raw mode),
     * but the distance accumulator stays sane.
     *
     * L29 fix: accepts an optional [precomputedDistanceM] so callers that
     * have already computed the haversine (e.g. the raw-mode radial filter)
     * can pass it in instead of recomputing it here. When null, the
     * function computes the distance itself.
     *
     * L22 fix: sub-half-second dt (50–200 ms) bypasses the velocity gate.
     * See the on-the-fly filter comment in onLocationChanged for details.
     *
     * BUGFIX (raw-mode distance leakage): previously this function updated
     * `prevLat` / `prevLon` / `prevTimeMs` UNCONDITIONALLY at the end, even
     * when the candidate was rejected by the accuracy or velocity gate. That
     * meant the next fix's distance was computed from the rejected outlier
     * instead of the last good point — so a single GPS glitch (e.g. a 200 m
     * teleport) added the *return* hop back to the true track on the next
     * fix, even though the outbound hop was correctly dropped. The displayed
     * distance silently grew by the size of every glitch.
     *
     * Now we only advance the cursor when the candidate is ACCEPTED. If the
     * candidate is rejected, the cursor stays at the last good fix and the
     * next fix is compared against that — which is what the on-the-fly filter
     * path already did. The two paths now behave identically w.r.t. the
     * prev cursor; they differ only in whether the raw point is appended to
     * the buffer.
     */
    private fun accumulateDistance(pt: GpsPoint, precomputedDistanceM: Double? = null) {
        val acc = pt.accuracy
        if (acc != null && acc > ACCURACY_THRESHOLD_M) {
            // Fix too inaccurate to trust for distance — skip but don't advance
            // prev. The next fix is compared against the last good point.
            return
        }
        val pLat = prevLat
        val pLon = prevLon
        val pTime = prevTimeMs
        if (pLat != null && pLon != null && pTime != null) {
            val dtSec = (pt.timeMs - pTime) / 1000.0
            if (dtSec <= 0.0) {
                // Zero/negative dt (duplicate timestamp or clock skew). Drop
                // without advancing prev — the next fix's dt will be measured
                // from the last good fix.
                SafeLog.d(TAG, "accumulateDistance: dropping zero-dt fix (dt=${dtSec}s)")
                return
            }
            val d = precomputedDistanceM ?: TrackMath.haversineMeters(pLat, pLon, pt.lat, pt.lon)
            // L22 fix: bypass velocity gate for sub-half-second dt — the
            // displacement is too small to produce a reliable velocity.
            if (dtSec >= MIN_VELOCITY_GATE_DT_SEC) {
                val velocityMps = d / dtSec
                // Drop the contribution if the implied velocity exceeds the walk/
                // run ceiling. These are usually GPS glitches after a cold start
                // or tunnel exit; they would otherwise inflate totalDistanceM.
                if (velocityMps > MAX_VELOCITY_MPS) {
                    SafeLog.d(TAG, "accumulateDistance: dropping velocity outlier (v=${velocityMps}m/s d=${d}m dt=${dtSec}s)")
                    // Do NOT advance prev — keep the last good fix as the
                    // reference so the next fix's distance is computed from it,
                    // not from this outlier.
                    return
                }
            }
            totalDistanceM += d
        }
        // Candidate accepted (or no prev to compare against) — advance cursor.
        prevLat = pt.lat
        prevLon = pt.lon
        prevTimeMs = pt.timeMs
    }

    // K5: saveLiveState / persistRawWindow / restoreRawWindow extracted to
    // StateRepository. Call sites go through `stateRepository.xxx(...)`.

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



    private fun cleanupGpsAndWakeLock() {
        locationSource.stopLocationUpdates()
        locationSource.stopGnssStatusTracking()
        wakeLockManager.release()
        handler.removeCallbacks(durationTick)
        handler.removeCallbacks(flushTick)
    }

    // ------------------------------------------------------------------
    // GPX file writing
    // ------------------------------------------------------------------


    /**
     * Reads the post-process setting from the SEPARATE settings prefs file.
     * The setting is written by GpsRecorderModule.setPostProcessEnabled() from JS.
     * Stored apart from `gps_recorder_state` so it survives the per-recording clear.
     */
    private fun isPostProcessEnabled(): Boolean = GpsRecorderSettings.isPostProcessEnabled(this)

    /**
     * Reads the Gaussian-smoothing setting from the SEPARATE settings prefs file.
     * When enabled, gpxFileSaver.finalizeGpxFile() will (after writing the raw / on-the-fly-
     * filtered GPX file) read it back, apply a Gaussian kernel smoother to the
     * lat/lon coordinates, and overwrite the file with the smoothed track.
     *
     * Stored in the same prefs file as `post_process_enabled` so it survives the
     * per-recording state clear.
     */
    private fun isGaussianSmoothingEnabled(): Boolean = GpsRecorderSettings.isGaussianSmoothingEnabled(this)

    /**
     * Reads the radial-distance on-the-fly filter setting from the separate
     * settings prefs file. When enabled, onLocationChanged drops every fix
     * whose great-circle distance to the LAST KEPT point is < threshold
     * (see [getRadialDistanceThresholdM]). The first fix of each segment
     * (prevLat == null) is always kept.
     */
    private fun isRadialDistanceFilterEnabled(): Boolean = GpsRecorderSettings.isRadialDistanceFilterEnabled(this)

    private fun getRadialDistanceThresholdM(): Int = GpsRecorderSettings.getRadialDistanceThresholdM(this)

    /**
     * Reads the time-sampling on-the-fly filter setting. When enabled,
     * onLocationChanged keeps every N-th fix (counter % N == 0) and drops
     * the rest. The very first fix of a recording is always kept so the
     * track has a starting point even if N > 1.
     */
    private fun isTimeSamplingEnabled(): Boolean = GpsRecorderSettings.isTimeSamplingEnabled(this)

    private fun getTimeSamplingN(): Int = GpsRecorderSettings.getTimeSamplingN(this)

    /**
     * Reads the Douglas-Peucker post-processing setting. When enabled,
     * gpxFileSaver.finalizeGpxFile() — AFTER writing the raw / on-the-fly-filtered GPX
     * file AND after Gaussian smoothing (if that is also enabled) — reads
     * the file back, applies Douglas-Peucker to each <trkseg> independently,
     * and overwrites the file with the simplified track.
     */
    private fun isDouglasPeuckerEnabled(): Boolean = GpsRecorderSettings.isDouglasPeuckerEnabled(this)

    private fun getDouglasPeuckerEpsilonM(): Double = GpsRecorderSettings.getDouglasPeuckerEpsilonM(this)

    // K5: persistState / clearPersistedState / recoverStateIfAny extracted
    // to StateRepository. Call sites go through `stateRepository.xxx(...)`.



    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    internal fun getElapsedMs(): Long =
        if (isRecording) System.currentTimeMillis() - startTimeMs else 0L
}
