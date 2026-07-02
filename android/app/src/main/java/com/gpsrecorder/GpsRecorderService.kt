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
            GpsEventEmitter.emitError(msg, fatal = true)
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
        segmentsSnapshot = { segmentedBuffer.segmentsSnapshot() },
        setBuffer = { segments, totalPoints ->
            synchronized(segmentedBuffer.pointBufferLock) {
                segmentedBuffer.trackSegments.clear()
                segmentedBuffer.currentSegment = if (segments.isEmpty()) ArrayList() else ArrayList(segments.last())
                if (segments.size > 1) {
                    for (i in 0 until segments.size - 1) {
                        segmentedBuffer.trackSegments.add(ArrayList(segments[i]))
                    }
                }
                pointCount = totalPoints
            }
        },
        setAppendState = { init, segs, size -> },
    )
    internal val gpxFileSaver = GpxFileSaver(
        service = this,
        segmentsSnapshot = { segmentedBuffer.segmentsSnapshot() },
        startTimeMs = { startTimeMs },
        deleteTempFile = { tempFileBuffer.deleteTempFile() },
    )

    // K6: segmented buffer + auto-pause/gap-detection controller.
    // Extracted from GpsRecorderService.kt — see SegmentedBuffer.kt and
    // AutoPauseGapController.kt for the relocated state machine. The actual
    // state fields (isAutoPaused, signalLost, movingMs, lastResumeMs,
    // autoPauseResumeGraceUntilMs, consecutiveMovingFixes, rawWindow,
    // prevLat/prevLon/prevTimeMs) remain on the service as @Volatile
    // internal vars so the 470-line onLocationChanged method can read/write
    // them directly without changing hundreds of references; the controller
    // methods operate on them via `service.` references.
    internal val segmentedBuffer = SegmentedBuffer()
    internal val autoPauseGap = AutoPauseGapController(this)

    // K5: state persistence / recovery helper.
    // K7: made `internal` so LocationChangedHandler can call
    // saveLiveState() via `service.stateRepository.saveLiveState(pt)`.
    internal val stateRepository = StateRepository(this)

    // K7: onLocationChanged / accumulateDistance extracted to a dedicated
    // LocationListener implementation. The service still implements
    // LocationListener (because `locationSource` takes a LocationListener
    // param) but delegates the four overrides to this handler.
    private val locationHandler = LocationChangedHandler(this)

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
        internal const val ACCURACY_THRESHOLD_M = 25.0f

        // Maximum acceptable age of a GPS fix (ms). Fixes older than this are dropped
        // in onLocationChanged to prevent stale cached fixes from inflating the
        // distance of a fresh recording. See "starts with 9 m / 69 m" bug fix.
        internal const val MAX_FIX_AGE_MS = 3000L

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
        internal const val MAX_VELOCITY_MPS = 5.5556f   // 20 km/h walking/running ceiling

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
        internal const val AUTO_PAUSE_RAW_WINDOW_MS = 10_000L
        // Instantaneous speed below which the user is considered stationary.
        // 0.35 m/s ~ 1.26 km/h — a slow shuffle; anything below this is
        // effectively standing still.
        internal const val AUTO_PAUSE_SPEED_THRESHOLD_MPS = 0.35f
        // Maximum pairwise displacement within the sliding window below
        // which the user is considered stationary (i.e. not just bouncing
        // in place due to GPS noise). 3.5 m ~ the diameter of a typical
        // urban GPS noise bubble when standing still.
        internal const val AUTO_PAUSE_DISPLACEMENT_THRESHOLD_M = 3.5

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
        internal const val MOVING_CONFIRMATION_THRESHOLD = 3   // consecutive fixes
        internal const val HYSTERESIS_SPEED_MS = 0.5f          // 0.5 m/s ≈ slow walk
        internal const val HYSTERESIS_DISPLACEMENT_MPS = 1.5   // fallback when speed is null/0
        internal const val KEY_CONSECUTIVE_MOVING_FIXES = "consecutive_moving_fixes"

        // ---- Gap detection (signal loss) (Phase 4) ----
        // If no GPS fix arrives for this many ms, declare a signal gap and
        // split the track into a new <trkseg> when the next fix does arrive.
        internal const val GAP_THRESHOLD_MS = 15_000L

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
        internal const val MIN_VELOCITY_GATE_DT_SEC = 0.5

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
    // K6: trackSegments / currentSegment / pointBufferLock moved to
    // SegmentedBuffer.kt — access them via `segmentedBuffer.xxx`. The
    // service still synchronizes on `segmentedBuffer.pointBufferLock` for
    // the recovery / reload paths (see TempFileBuffer.setBuffer lambda
    // above and StateRepository.recoverStateIfAny).

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

    // K7: timeSamplingCounter moved to LocationChangedHandler (the handler
    // owns it because the time-sampling gate runs entirely inside
    // onLocationChanged, which now lives on the handler).

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
                    autoPauseGap.liveMovingMs(now)
                }
                GpsEventEmitter.emitDuration(elapsed, currentMovingMs)

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
                        autoPauseGap.persistAutoPauseState()
                        notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = pointCount,
                elapsedMs = getElapsedMs(),
                isAutoPaused = isAutoPaused,
                signalLost = signalLost
            )
        )
                        GpsEventEmitter.emitState(
                            isRecording, pointCount, getElapsedMs(),
                            isAutoPaused, signalLost, autoPauseGap.liveMovingMs(now)
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
            // Phase 2: reset segmented buffer (K6: moved to SegmentedBuffer).
            segmentedBuffer.reset()
            // Phase 3/4/6: reset auto-pause + gap-detection + moving-time
            // state (K6: moved to AutoPauseGapController). The controller's
            // reset() reads `startTimeMs` (just set above) so lastResumeMs
            // is initialized to the recording start.
            autoPauseGap.reset()
            // K7: reset the time-sampling counter (now owned by
            // LocationChangedHandler) so the new recording starts at fix #1
            // (always kept under any N because 1 % N != 0 is false only for
            // N=1; the handler treats the very first fix specially — see
            // LocationChangedHandler.onLocationChanged — so the first fix of
            // a recording is always kept regardless of N).
            locationHandler.timeSamplingCounter = 0
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
            GpsEventEmitter.emitError("Не удалось запустить foreground service", fatal = true)
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

        GpsEventEmitter.emitState(
            true, pointCount, System.currentTimeMillis() - startTimeMs,
            isAutoPaused, signalLost, autoPauseGap.liveMovingMs()
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
            GpsEventEmitter.emitSaved(savedFilePath, pointCount, finalDistanceM)
        }
        GpsEventEmitter.emitState(false, 0, 0L, false, false, 0L)

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
    // (K6: state machine moved to SegmentedBuffer.kt + AutoPauseGapController.kt;
    //  only the settings readers remain here.)
    // ------------------------------------------------------------------

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

    // K6: persistAutoPauseState / enterAutoPause / exitAutoPause /
    // handleGapRecovery / liveMovingMs / resetValidationCursor /
    // maxDisplacementInWindow moved to AutoPauseGapController.kt.
    // Call sites go through `autoPauseGap.xxx(...)`.

    // ------------------------------------------------------------------
    // GPS callback
    // ------------------------------------------------------------------
    //
    // K7: the 470-line onLocationChanged body (8 filter stages: stale-fix,
    // gap-detection / recovery, auto-pause enter / exit hysteresis,
    // time-sampling, accuracy, velocity, radial-distance, raw-mode distance
    // accumulator) was extracted verbatim to LocationChangedHandler.kt so
    // this file could get under 1000 lines. The service still implements
    // LocationListener (because LocationSource takes a LocationListener
    // param) but every override is a one-line delegation to the handler.

    override fun onLocationChanged(location: Location) =
        locationHandler.onLocationChanged(location)

    // K7: accumulateDistance moved to LocationChangedHandler. The handler
    // calls it as a private method from inside its onLocationChanged
    // (raw-mode branch only — see the `else` clause after the
    // isPostProcessEnabled gate).

    // K5: saveLiveState / persistRawWindow / restoreRawWindow extracted to
    // StateRepository. Call sites go through `stateRepository.xxx(...)`.

    // Required overrides for older Android API levels (K7: delegated to
    // LocationChangedHandler).
    override fun onProviderEnabled(provider: String) =
        locationHandler.onProviderEnabled(provider)

    override fun onProviderDisabled(provider: String) =
        locationHandler.onProviderDisabled(provider)

    @Deprecated("legacy")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) =
        locationHandler.onStatusChanged(provider, status, extras)

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

    internal fun getRadialDistanceThresholdM(): Int = GpsRecorderSettings.getRadialDistanceThresholdM(this)

    /**
     * Reads the time-sampling on-the-fly filter setting. When enabled,
     * onLocationChanged keeps every N-th fix (counter % N == 0) and drops
     * the rest. The very first fix of a recording is always kept so the
     * track has a starting point even if N > 1.
     */
    private fun isTimeSamplingEnabled(): Boolean = GpsRecorderSettings.isTimeSamplingEnabled(this)

    internal fun getTimeSamplingN(): Int = GpsRecorderSettings.getTimeSamplingN(this)

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
