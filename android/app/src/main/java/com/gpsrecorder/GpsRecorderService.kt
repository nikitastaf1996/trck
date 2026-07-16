package com.gpsrecorder

import android.app.Service
import android.content.Intent
import android.location.Location
import android.location.LocationListener
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import java.util.LinkedList
import java.util.concurrent.Executors

/**
 * GpsRecorderService
 *
 * Foreground service that records GPS locations in the background and writes a
 * GPX file to the public Downloads folder when recording stops.
 *
 * Stability features: foreground service + persistent notification (Android is
 * reluctant to kill it); START_STICKY (recovers from SharedPreferences + on-disk
 * temp file); PARTIAL_WAKE_LOCK (CPU stays awake while screen is off); periodic
 * flush of in-memory points to a temp file (crash recovery); onTaskRemoved does
 * NOT stop the service (user stops via notification); the service does NOT
 * depend on the JS app being alive — it can run, stop, and save the file
 * entirely on its own.
 */
class GpsRecorderService : Service(), LocationListener {

    // O7/O24: extracted helper modules.
    internal val notifier = GpsRecorderNotification(this)

    internal val locationSource = LocationSource(
        service = this,
        listener = this,
        onFatalError = { msg ->
            GpsEventEmitter.emitError(msg, fatal = true)
            stopRecording()
        },
        onGnssStatusPersist = { sats, fixType ->
            try {
                getSharedPreferences(StateRepository.PREFS_NAME, android.content.Context.MODE_PRIVATE)
                    .edit()
                    .putInt(StateRepository.KEY_SATELLITES_USED, sats)
                    .putString(StateRepository.KEY_FIX_TYPE, fixType)
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

    // K6: segmented buffer + auto-pause/gap-detection controller. State
    // fields stay on the service as @Volatile internal vars so the
    // onLocationChanged handler can read/write them directly; the
    // controller methods operate on them via `service.` references.
    internal val segmentedBuffer = SegmentedBuffer()
    internal val autoPauseGap = AutoPauseGapController(this)

    // K5: state persistence / recovery helper (internal so
    // LocationChangedHandler can call saveLiveState via `service.`).
    internal val stateRepository = StateRepository(this)

    // K7: onLocationChanged / accumulateDistance extracted to a dedicated
    // LocationListener implementation. The service still implements
    // LocationListener (locationSource takes a LocationListener param) but
    // delegates the four overrides to this handler.
    private val locationHandler = LocationChangedHandler(this)

    companion object {
        internal const val TAG = "GpsRecorderService"

        const val ACTION_START = "com.gpsrecorder.action.START"
        const val ACTION_STOP = "com.gpsrecorder.action.STOP"
        const val ACTION_NOTIFICATION_STOP = "com.gpsrecorder.action.NOTIF_STOP"

        // How often we flush points to disk (for crash recovery)
        private const val FLUSH_INTERVAL_MS = 5000L
    }

    private var handler: Handler = Handler(Looper.getMainLooper())

    // M1 fix (Task 4): single-thread executor for the slow GPX finalization
    // (serialize + MediaStore I/O + Gaussian smoothing + Douglas-Peucker +
    // distance recompute). Running this on the main thread risked ANRs on
    // long tracks (a 3-hour walk at 1 Hz = ~10 800 points, plus the
    // post-processors re-parsing the file twice). The executor is
    // single-threaded so concurrent stop requests are serialized — the
    // second stop sees isRecording=false and returns early (see
    // stopRecording's first guard).
    //
    // The executor is NEVER shut down via shutdownNow() while a finalize
    // is in progress — that would interrupt file I/O and corrupt the
    // output. onDestroy() lets any in-flight task complete (the service
    // stays alive because stopSelf() is only called from the main-thread
    // callback that runs AFTER the finalize completes).
    private val saveExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "trck-gpx-saver").apply { isDaemon = true }
    }

    // ---- Recording state (persisted to SharedPreferences for recovery) ----
    @Volatile internal var isRecording = false
    internal var startTimeMs: Long = 0L
    @Volatile internal var pointCount: Int = 0
    internal var tempFileName: String? = null

    // Distance accumulator (meters). Persisted so it survives service restarts.
    @Volatile internal var totalDistanceM: Double = 0.0

    // Wall-clock time of the last accepted fix (ms). Used by the gap watchdog
    // (durationTick) and by LocationSource.computeFixType to declare "no fix".
    @Volatile internal var lastFixTimeMs: Long = 0L

    // Previous accepted fix cursor (Haversine distance + dt for velocity gate).
    // Nullified by resetValidationCursor() on auto-pause / gap-recovery so the
    // next accepted fix isn't validated against a stale previous point.
    @Volatile internal var prevLat: Double? = null
    @Volatile internal var prevLon: Double? = null
    @Volatile internal var prevTimeMs: Long? = null

    // ---- Auto-pause state (Phase 3) ----
    // K6: trackSegments / currentSegment / pointBufferLock moved to SegmentedBuffer.kt.
    @Volatile internal var isAutoPaused: Boolean = false
    // Sliding window of the last AutoPauseGapController.RAW_WINDOW_MS of raw fixes,
    // used to compute displacement for stop detection (raw = fixes from
    // onLocationChanged regardless of on-the-fly filter pass/fail).
    internal val rawWindow: LinkedList<GpsPoint> = LinkedList()

    // ---- Gap detection state (Phase 4) ----
    // True when the watchdog has declared a signal gap (no fix in
    // AutoPauseGapController.GAP_THRESHOLD_MS). Cleared on gap recovery inside onLocationChanged.
    @Volatile internal var signalLost: Boolean = false

    // ---- Moving time accumulator (Phase 6 helper) ----
    // When auto-pause is enabled, this accumulates ONLY the time spent actually
    // moving (not in isAutoPaused). Used by JS to compute pace based on active
    // moving time instead of wall-clock elapsed time.
    @Volatile internal var movingMs: Long = 0L
    @Volatile internal var lastResumeMs: Long? = null

    // ---- Auto-pause resume grace window (CODE_REVIEW_TODO Task 1) ----
    // While now < autoPauseResumeGraceUntilMs, the gap watchdog (durationTick)
    // and the gap-recovery branch in onLocationChanged MUST NOT fire. Set by
    // exitAutoPause() to (now + AutoPauseGapController.GAP_THRESHOLD_MS) so a stale
    // lastFixTimeMs (left over from when the user was stationary) can't trigger
    // a false signalLost declaration or a spurious segment split immediately
    // after resume.
    @Volatile internal var autoPauseResumeGraceUntilMs: Long = 0L

    // ---- Auto-pause exit hysteresis (CODE_REVIEW_TODO Task 2) ----
    // Counts consecutive "clearly moving" fixes while isAutoPaused. When it
    // reaches AutoPauseGapController.MOVING_CONFIRMATION_THRESHOLD, exitAutoPause() fires and
    // the counter resets to 0. A slow fix (< AutoPauseGapController.HYSTERESIS_SPEED_MS) resets it.
    @Volatile internal var consecutiveMovingFixes: Int = 0

    // K7: timeSamplingCounter moved to LocationChangedHandler.
    // L26: append-only temp-file state lives on TempFileBuffer.

    // Duration tick runnable (1 Hz). Emits elapsed + movingMs every tick (L8
    // fix: previously movingMs was only updated on 'location' events, so the
    // displayed avg pace oscillated). Also runs the gap-detection watchdog
    // (L15 fix: moved here from flushTick so the signal-lost threshold is
    // truly 15 s instead of 15–20 s).
    //
    // K9: the gap-watchdog logic itself is extracted to
    // AutoPauseGapController.checkGapWatchdog (freezes movingMs at the last
    // fix, persists state, returns true if signalLost was just set). The
    // notification refresh + state emission stay here.
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

                // Gap watchdog — see AutoPauseGapController.checkGapWatchdog.
                if (autoPauseGap.checkGapWatchdog(now, isGapDetectionEnabled())) {
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

                handler.postDelayed(this, 1000L)
            }
        }
    }

    // Periodic flush to temp file (5 s cadence). L15: the gap-detection
    // watchdog was previously here; it has been moved to durationTick (1 Hz)
    // so the signal-lost threshold is truly 15 s. This tick now only flushes
    // in-memory points to the temp file for crash recovery.
    private val flushTick = object : Runnable {
        override fun run() {
            if (isRecording) {
                tempFileBuffer.flush()
                handler.postDelayed(this, FLUSH_INTERVAL_MS)
            }
        }
    }

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
        // User swiped the app away from recents. We deliberately KEEP the
        // service running so the recording does not die. The user can stop
        // it from the notification.
        Log.i(TAG, "onTaskRemoved - keeping service alive")
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        Log.i(TAG, "Service onDestroy")
        // If we are being destroyed while still recording, do a final flush so
        // we don't lose data. The temp file + SharedPreferences preserve the
        // in-progress recording across the (START_STICKY) restart.
        if (isRecording) {
            // L25: force a final live-state save before destroy so the throttled
            // saveLiveState doesn't drop the most recent fixes.
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
            // System restarted the service (START_STICKY). Only resume if we
            // genuinely were recording; otherwise there is nothing to resume.
            if (!isRecording) {
                Log.i(TAG, "System restarted service but we weren't recording — stopping")
                stopSelf()
                return
            }
            Log.i(TAG, "Resuming recording after system restart")
            // Do NOT reset state — continue from where we left off. If we were
            // not auto-paused when the service was killed, treat the resume
            // instant as the start of a new moving segment so movingMs
            // accumulates correctly going forward.
            if (!isAutoPaused) {
                lastResumeMs = System.currentTimeMillis()
            }
        } else {
            // User pressed START. Always start a fresh recording, even if
            // isRecording happens to be true (leftover state from a previous
            // session killed before stopRecording() could clear prefs).
            // Without this, totalDistanceM from the previous session would
            // leak into the new one — the "starts with 69 m" bug.
            if (isRecording) {
                Log.w(TAG, "User pressed START while isRecording=true (leftover state) — resetting")
            }
            resetForFreshRecording()
        }
        isRecording = true

        // Persist state so we can recover after a crash/restart
        stateRepository.persistState()
        // Acquire wakelock so CPU stays awake while screen is off
        wakeLockManager.acquire()

        // Start the foreground notification FIRST (Android requires this
        // within 5s of startForegroundService()).
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

        // L1 fix: startLocationUpdates() returns Boolean. If false it has
        // ALREADY called stopRecording() — we MUST bail out here without
        // registering the GNSS callback, posting the tick handlers, writing
        // a new temp file header, or emitting state=true.
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

    /**
     * K9: Reset all per-recording state for a fresh START. Extracted from
     * `startRecording` so that method fits the L1 early-return contract more
     * clearly. The auto-pause controller's `reset()` reads `startTimeMs`
     * (set here) so `lastResumeMs` is initialized to the recording start.
     */
    private fun resetForFreshRecording() {
        startTimeMs = System.currentTimeMillis()
        pointCount = 0
        totalDistanceM = 0.0
        prevLat = null
        prevLon = null
        prevTimeMs = null
        locationSource.resetSatellites()
        lastFixTimeMs = 0L
        segmentedBuffer.reset()
        autoPauseGap.reset()
        locationHandler.timeSamplingCounter = 0
        tempFileName = "gps_temp_${startTimeMs}.gpx"
        tempFileBuffer.tempFileName = tempFileName
        // L25: reset the saveLiveState throttle so the first fix is persisted
        // immediately (not skipped by the 5 s throttle).
        stateRepository.resetThrottle()
        // L26: reset the append-only temp-file state. The temp file itself
        // is overwritten in tempFileBuffer.writeGpxHeader() below.
        tempFileBuffer.resetState()
    }

    private fun stopRecording() {
        if (!isRecording) {
            Log.i(TAG, "Not recording, ignoring stop")
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

        // Finalize the moving-time accumulator (segment from last resume up to
        // the LAST FIX). See AutoPauseGapController.finalizeMovingTimeAtStop.
        autoPauseGap.finalizeMovingTimeAtStop()

        // L25: force a final live-state save BEFORE finalizeGpxFile so the
        // throttled saveLiveState doesn't drop the most recent fixes / state.
        stateRepository.saveLiveState(force = true)

        // M1 fix (Task 4): run the slow GPX finalization on a background
        // thread. The orchestration (state cleanup, emitSaved, stopForeground,
        // stopSelf) is posted back to the main thread via `handler.post` once
        // the background work completes.
        //
        // The wake lock is held until the finalize completes — releasing it
        // early could let the CPU sleep mid-finalize on a long track
        // (Gaussian smoothing + Douglas-Peucker on a 3-hour recording can
        // take several seconds).
        //
        // Thread-safety notes:
        //   - segmentsSnapshot() takes the pointBufferLock, which is
        //     thread-safe.
        //   - GpxPostProcessors are pure string→string transforms with no
        //     shared mutable state.
        //   - MediaStore / ContentResolver are thread-safe.
        //   - GpsEventEmitter.send() reads a @Volatile field and posts to
        //     RCTDeviceEventEmitter (which is itself thread-safe).
        //   - stateRepository.clearPersistedState() uses SharedPreferences
        //     .edit().apply(), which is thread-safe.
        // The `pointCount` field is @Volatile and is only read (not written)
        // in the background task; the value is the final count.
        //
        // Try/finally ensures the main-thread cleanup ALWAYS runs, even if
        // the finalize throws an unexpected exception (OOM, IO error after
        // the file fallback, etc.) — otherwise the service would stay in
        // a half-stopped state with the foreground notification up forever.
        saveExecutor.execute {
            val savedFilePath: String
            val savedOk: Boolean
            val finalDistanceM: Double
            try {
                savedFilePath = gpxFileSaver.finalizeGpxFile()
                savedOk = savedFilePath.isNotEmpty()
                // Recompute the final distance from the SAVED GPX file so
                // the value the user sees matches the track length Strava
                // / other importers will compute (matters most when
                // Gaussian smoothing is on — smoothing shortens the track
                // a few percent vs. the raw live-accumulated haversine
                // distance). On failure we fall back to -1.0, which JS
                // interprets as "keep the live-accumulated distance".
                finalDistanceM = if (savedOk) gpxFileSaver.recomputeDistanceFromSavedGpx(savedFilePath) else -1.0
            } catch (e: Throwable) {
                Log.e(TAG, "Background GPX finalize threw — recovering UI to idle", e)
                savedFilePath = ""
                savedOk = false
                finalDistanceM = -1.0
            } finally {
                // Post the main-thread cleanup back to the main Handler.
                // This MUST run on the main thread because:
                //   - stopForeground / stopSelf must be called from the
                //     main thread (Service lifecycle methods).
                //   - GpsEventEmitter.emitSaved / emitState touch the
                //     ReactApplicationContext, which is safest to access
                //     from the main thread.
                //   - wakeLockManager.release() must be called from the
                //     main thread (PowerManager.WakeLock is thread-safe
                //     but the surrounding code expects main-thread access).
                handler.post {
                    // L5: only emit 'saved' when we actually wrote a file.
                    // The empty sentinel means gpxFileSaver.finalizeGpxFile()
                    // bailed out early because the buffer was empty —
                    // emitting a 'saved' event in that case would make the
                    // UI flash a 'GPX СОХРАНЁН' card with no real file
                    // behind it.
                    //
                    // Task 7 (empty-save UI feedback): when the save was
                    // empty (no usable segments), emit a NON-FATAL 'error'
                    // event with a user-facing message so the JS UI can
                    // surface it via the ErrorCard. Previously the
                    // recording was silently discarded and the user was
                    // left wondering why no GPX file appeared in
                    // Downloads/trck/. The 'fatal=false' flag means the
                    // JS UI does NOT reset to idle on this error (it's
                    // already transitioning to idle via emitState below).
                    if (savedOk) {
                        GpsEventEmitter.emitSaved(savedFilePath, pointCount, finalDistanceM)
                    } else {
                        GpsEventEmitter.emitError(
                            "Запись остановлена без сохранения: не было получено ни одной GPS-фиксации (или все точки были отфильтрованы). GPX-файл не создан.",
                            fatal = false
                        )
                    }
                    GpsEventEmitter.emitState(false, 0, 0L, false, false, 0L)

                    // Clear persisted state + release wakelock AFTER the
                    // finalize completes. Doing this earlier would risk
                    // losing the recovery state if the service were killed
                    // mid-finalize.
                    stateRepository.clearPersistedState()
                    wakeLockManager.release()

                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Settings readers (delegate to GpsRecorderSettings)
    // ------------------------------------------------------------------

    /** Auto-pause toggle (separate prefs file so it survives the per-recording clear). */
    private fun isAutoPauseEnabled(): Boolean = GpsRecorderSettings.isAutoPauseEnabled(this)

    /**
     * Gap-detection toggle. When enabled (default), the durationTick watchdog
     * declares signalLost after AutoPauseGapController.GAP_THRESHOLD_MS without a
     * fix, and the next arriving fix triggers a segment split. When disabled,
     * gaps are NOT detected (timer keeps running, next fix appended to the
     * same segment, velocity gate compares it against the pre-gap point).
     */
    private fun isGapDetectionEnabled(): Boolean = GpsRecorderSettings.isGapDetectionEnabled(this)

    // ---- LocationListener overrides (K7: delegated to LocationChangedHandler) ----

    override fun onLocationChanged(location: Location) =
        locationHandler.onLocationChanged(location)

    override fun onProviderEnabled(provider: String) =
        locationHandler.onProviderEnabled(provider)

    override fun onProviderDisabled(provider: String) =
        locationHandler.onProviderDisabled(provider)

    @Deprecated("legacy")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) =
        locationHandler.onStatusChanged(provider, status, extras)

    private fun cleanupGpsAndWakeLock() {
        locationSource.stopLocationUpdates()
        locationSource.stopGnssStatusTracking()
        wakeLockManager.release()
        handler.removeCallbacks(durationTick)
        handler.removeCallbacks(flushTick)
    }

    // ---- Settings readers (post-processing filters; delegate to GpsRecorderSettings) ----

    /** Reads the post-process (on-the-fly accuracy/velocity gate) setting. */
    private fun isPostProcessEnabled(): Boolean = GpsRecorderSettings.isPostProcessEnabled(this)
    /** Reads the Gaussian-smoothing post-process setting. */
    private fun isGaussianSmoothingEnabled(): Boolean = GpsRecorderSettings.isGaussianSmoothingEnabled(this)
    /** Reads the radial-distance on-the-fly filter setting. */
    private fun isRadialDistanceFilterEnabled(): Boolean = GpsRecorderSettings.isRadialDistanceFilterEnabled(this)
    internal fun getRadialDistanceThresholdM(): Int = GpsRecorderSettings.getRadialDistanceThresholdM(this)
    /** Reads the time-sampling on-the-fly filter setting. */
    private fun isTimeSamplingEnabled(): Boolean = GpsRecorderSettings.isTimeSamplingEnabled(this)
    internal fun getTimeSamplingN(): Int = GpsRecorderSettings.getTimeSamplingN(this)
    /** Reads the Douglas-Peucker post-processing setting. */
    private fun isDouglasPeuckerEnabled(): Boolean = GpsRecorderSettings.isDouglasPeuckerEnabled(this)
    private fun getDouglasPeuckerEpsilonM(): Double = GpsRecorderSettings.getDouglasPeuckerEpsilonM(this)

    internal fun getElapsedMs(): Long =
        if (isRecording) System.currentTimeMillis() - startTimeMs else 0L
}
