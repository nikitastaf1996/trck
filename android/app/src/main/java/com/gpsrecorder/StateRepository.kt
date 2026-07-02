package com.gpsrecorder

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * K5 — State persistence / recovery extracted from GpsRecorderService.kt.
 *
 * Encapsulates the START_STICKY recovery + live-state persistence machinery
 * that previously lived inline in [GpsRecorderService]:
 *   - [persistState] — writes the recording-state keys at start / stop
 *     boundaries so the service can recover after a crash / restart.
 *   - [clearPersistedState] — clears the prefs at stop time.
 *   - [recoverStateIfAny] — START_STICKY recovery: reads the persisted
 *     fields, reloads buffered points from the temp file, restores the
 *     raw auto-pause window, restores the prev cursor, and restarts the
 *     foreground notification BEFORE returning.
 *   - [saveLiveState] — throttled live-state persistence (5 s throttle;
 *     `force` bypasses). Called on every GPS fix so JS's getState() poll
 *     sees fresh data.
 *   - [persistRawWindow] / [restoreRawWindow] — serialize / deserialize
 *     the last AUTO_PAUSE_RAW_WINDOW_SIZE raw fixes so auto-pause
 *     detection can make a correct decision on the first fix after a
 *     START_STICKY restart.
 *
 * The class holds only the throttle bookkeeping ([lastSaveLiveStateMs] +
 * [SAVE_LIVE_STATE_THROTTLE_MS]); all actual recording state lives on the
 * service and is accessed via the [service] reference. This matches the
 * pattern used by [GpsRecorderNotification], [LocationSource], etc.
 *
 * Invariants preserved verbatim from the inline implementation:
 *   - L19: [recoverStateIfAny] restarts the foreground notification BEFORE
 *     returning so Android sees the service as foreground within 100 ms of
 *     onCreate() returning.
 *   - L20: [persistRawWindow] / [restoreRawWindow] keep the raw auto-pause
 *     window intact across service restarts.
 *   - L25: [saveLiveState] throttle (5 s, `force` bypasses). The first call
 *     of a new recording is persisted immediately because
 *     [GpsRecorderService.startRecording] calls [resetThrottle] on the
 *     non-resume path.
 *   - L21: >10% bad-timestamp reload abort (lives in [TempFileBuffer], but
 *     [recoverStateIfAny] calls into it).
 *   - Task 1: auto-pause resume grace window persistence
 *     (KEY_AUTO_PAUSE_RESUME_GRACE_UNTIL_MS).
 *   - Task 2: consecutiveMovingFixes persistence
 *     (KEY_CONSECUTIVE_MOVING_FIXES).
 */
class StateRepository(private val service: GpsRecorderService) {

    private val tag: String get() = GpsRecorderService.TAG

    // ---- L25: saveLiveState throttle ----
    // Last wall-clock time (ms) we called saveLiveState(). The next call
    // is skipped if `now - lastSaveLiveStateMs < SAVE_LIVE_STATE_THROTTLE_MS`.
    // Forced saves (before finalize / stopSelf) bypass the throttle by
    // calling saveLiveState(force = true).
    @Volatile private var lastSaveLiveStateMs: Long = 0L

    // ---- L25: throttle saveLiveState ----
    // Don't write SharedPreferences on every 1 Hz fix — that's ~60
    // disk writes per minute, each touching ~10 keys. Throttle to
    // once per 5 s. The final call before finalize / stop is always
    // made regardless of the throttle.
    private val SAVE_LIVE_STATE_THROTTLE_MS = 5_000L

    /**
     * Resets the saveLiveState throttle so the first saveLiveState call of
     * a new recording is persisted immediately (not skipped by the 5 s
     * throttle). Called from [GpsRecorderService.startRecording] on the
     * non-resume path right before [persistState].
     */
    fun resetThrottle() {
        lastSaveLiveStateMs = 0L
    }

    /**
     * Writes the current recording state + last fix to SharedPreferences.
     * Called on every GPS fix so that [GpsRecorderModule.getState] can return fresh data.
     *
     * Persists the LIVE moving time (liveMovingMs) so JS's 2-second
     * getState() polling fallback sees a fresh value, not the stale frozen
     * one. See CHANGELOG.md.
     */
    fun saveLiveState(lastFix: GpsPoint? = null, force: Boolean = false) {
        // L25 fix: throttle to once per SAVE_LIVE_STATE_THROTTLE_MS unless
        // the caller explicitly forces a save (e.g. before finalize / stop).
        // The previous version wrote SharedPreferences on every 1 Hz fix,
        // which is ~60 disk writes per minute — each touching ~10 keys —
        // for no good reason (JS polls getState() every 2 s anyway).
        val now = System.currentTimeMillis()
        if (!force && lastSaveLiveStateMs > 0L && (now - lastSaveLiveStateMs) < SAVE_LIVE_STATE_THROTTLE_MS) {
            return
        }
        lastSaveLiveStateMs = now
        try {
            val prefs = service.getSharedPreferences(GpsRecorderService.PREFS_NAME, Context.MODE_PRIVATE).edit()
            prefs.putBoolean(GpsRecorderService.KEY_IS_RECORDING, service.isRecording)
            prefs.putLong(GpsRecorderService.KEY_START_TIME, service.startTimeMs)
            prefs.putInt(GpsRecorderService.KEY_POINT_COUNT, service.pointCount)
            prefs.putString(GpsRecorderService.KEY_TOTAL_DISTANCE, service.totalDistanceM.toString())
            prefs.putString(GpsRecorderService.KEY_FIX_TYPE, service.locationSource.computeFixType(service.lastFixTimeMs))
            prefs.putInt(GpsRecorderService.KEY_SATELLITES_USED, service.locationSource.satellitesUsed)
            // Phase 1/3/4: persist auto-pause / signal-lost / moving-time so
            // JS can poll via getState() and survive service restarts.
            prefs.putBoolean(GpsRecorderService.KEY_IS_AUTO_PAUSED, service.isAutoPaused)
            prefs.putBoolean(GpsRecorderService.KEY_SIGNAL_LOST, service.signalLost)
            // Persist the LIVE value so polling sees the same value event
            // delivery would have shown. The frozen `movingMs` field stays
            // in memory as the "committed baseline" and is what we restart
            // from after a service restart (see recoverStateIfAny).
            val liveNow = lastFix?.timeMs ?: now
            prefs.putLong(GpsRecorderService.KEY_MOVING_MS, service.autoPauseGap.liveMovingMs(liveNow))
            // CODE_REVIEW_TODO Task 1: persist the auto-pause resume grace
            // window so it survives service restart. If the grace has
            // already expired by the time we recover, recoverStateIfAny
            // resets it to 0L.
            prefs.putLong(GpsRecorderService.KEY_AUTO_PAUSE_RESUME_GRACE_UNTIL_MS, service.autoPauseResumeGraceUntilMs)
            // CODE_REVIEW_TODO Task 2: persist the moving-confirmation counter
            // so a service restart mid-confirmation doesn't lose progress.
            // (If the service restarts mid-confirmation, the user has to
            // re-confirm 3 fixes — acceptable per Task 2.)
            prefs.putInt(GpsRecorderService.KEY_CONSECUTIVE_MOVING_FIXES, service.consecutiveMovingFixes)
            val fix = lastFix ?: synchronized(service.segmentedBuffer.pointBufferLock) { service.segmentedBuffer.currentSegment.lastOrNull() }
            if (fix != null) {
                prefs.putString(GpsRecorderService.KEY_LAST_LAT, fix.lat.toString())
                prefs.putString(GpsRecorderService.KEY_LAST_LON, fix.lon.toString())
                prefs.putString(GpsRecorderService.KEY_LAST_ALT, fix.alt?.toString() ?: "")
                prefs.putString(GpsRecorderService.KEY_LAST_SPEED, fix.speed?.toString() ?: "")
                prefs.putString(GpsRecorderService.KEY_LAST_ACCURACY, fix.accuracy?.toString() ?: "")
                prefs.putLong(GpsRecorderService.KEY_LAST_TIME_MS, fix.timeMs)
            }
            // L20 fix: persist the last AUTO_PAUSE_RAW_WINDOW_SIZE raw fixes
            // so auto-pause detection can make a correct decision on the
            // first fix after a START_STICKY restart. Without this the
            // window is empty and the user could be stationary but not yet
            // auto-paused, accumulating junk points, for ~10 s after restart.
            persistRawWindow(prefs)
            prefs.apply()
        } catch (e: Exception) {
            Log.w(tag, "saveLiveState failed", e)
        }
    }

    /**
     * L20 helper: serialize the last AUTO_PAUSE_RAW_WINDOW_SIZE entries of
     * `rawWindow` to a JSON array under KEY_RAW_WINDOW. Each entry is a
     * JSONObject with lat / lon / alt / speed / accuracy / timeMs so it can
     * be reconstructed losslessly on the other side.
     */
    private fun persistRawWindow(prefs: android.content.SharedPreferences.Editor) {
        try {
            val arr = JSONArray()
            // Snapshot under no lock — rawWindow is only touched on the
            // main thread by onLocationChanged, so this is safe.
            val snapshot = ArrayList(service.rawWindow)
            val start = snapshot.size.coerceAtLeast(0).let { (it - GpsRecorderService.AUTO_PAUSE_RAW_WINDOW_SIZE).coerceAtLeast(0) }
            for (i in start until snapshot.size) {
                val p = snapshot[i]
                val o = JSONObject()
                o.put("lat", p.lat)
                o.put("lon", p.lon)
                p.alt?.let { o.put("alt", it) }
                p.speed?.let { o.put("speed", it.toDouble()) }
                p.accuracy?.let { o.put("accuracy", it.toDouble()) }
                o.put("timeMs", p.timeMs)
                arr.put(o)
            }
            prefs.putString(GpsRecorderService.KEY_RAW_WINDOW, arr.toString())
        } catch (e: Exception) {
            Log.w(tag, "persistRawWindow failed", e)
        }
    }

    /**
     * L20 helper: deserialize the raw_window JSON array from prefs back into
     * `rawWindow`. Called from [recoverStateIfAny] on service restart. If
     * deserialization fails for any reason, log and continue with an empty
     * window (graceful degradation — the auto-pause logic will just take
     * ~10 s to re-fill the window before making a stop decision).
     */
    private fun restoreRawWindow(prefs: android.content.SharedPreferences) {
        val json = prefs.getString(GpsRecorderService.KEY_RAW_WINDOW, null) ?: return
        try {
            val arr = JSONArray(json)
            service.rawWindow.clear()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val alt = if (o.has("alt") && !o.isNull("alt")) o.getDouble("alt") else null
                val speed = if (o.has("speed") && !o.isNull("speed")) o.getDouble("speed").toFloat() else null
                val accuracy = if (o.has("accuracy") && !o.isNull("accuracy")) o.getDouble("accuracy").toFloat() else null
                service.rawWindow.add(GpsPoint(
                    lat = o.getDouble("lat"),
                    lon = o.getDouble("lon"),
                    alt = alt,
                    speed = speed,
                    accuracy = accuracy,
                    timeMs = o.getLong("timeMs")
                ))
            }
            Log.i(tag, "restoreRawWindow: restored ${service.rawWindow.size} raw fixes")
        } catch (e: Exception) {
            Log.w(tag, "restoreRawWindow failed — continuing with empty window", e)
            service.rawWindow.clear()
        }
    }

    /**
     * Persists the recording state at start/stop boundaries so the service
     * can recover from a crash / START_STICKY restart.
     *
     * Writes the same set of keys as [saveLiveState] except for the
     * temp-file name (only [persistState] persists that) and the last-fix
     * block + raw window (only [saveLiveState] persists those). Both
     * persisters write the auto-pause / signal-lost / moving-time trio.
     */
    fun persistState() {
        val prefs = service.getSharedPreferences(GpsRecorderService.PREFS_NAME, Context.MODE_PRIVATE).edit()
        prefs.putBoolean(GpsRecorderService.KEY_IS_RECORDING, service.isRecording)
        prefs.putLong(GpsRecorderService.KEY_START_TIME, service.startTimeMs)
        prefs.putInt(GpsRecorderService.KEY_POINT_COUNT, service.pointCount)
        prefs.putString(GpsRecorderService.KEY_TEMP_FILE_NAME, service.tempFileName)
        prefs.putString(GpsRecorderService.KEY_TOTAL_DISTANCE, service.totalDistanceM.toString())
        // Phase 1/3/4: persist auto-pause / signal-lost / moving-time so
        // they survive service restarts. (saveLiveState also writes these on
        // every fix, but persistState is called at start / stop boundaries.)
        prefs.putBoolean(GpsRecorderService.KEY_IS_AUTO_PAUSED, service.isAutoPaused)
        prefs.putBoolean(GpsRecorderService.KEY_SIGNAL_LOST, service.signalLost)
        // Persist the LIVE movingMs (committed baseline + uncommitted delta
        // since last resume) so that on service restart the recovered value
        // matches what the UI was showing right before the kill. After
        // recovery, lastResumeMs is set to the recovery instant, so the
        // post-recovery liveMovingMs starts ticking from this persisted
        // baseline (the period between the last save and recovery is NOT
        // counted, because we don't know whether the user was moving).
        prefs.putLong(GpsRecorderService.KEY_MOVING_MS, service.autoPauseGap.liveMovingMs())
        prefs.apply()
    }

    /**
     * Clears the persisted recording state. Called from
     * [GpsRecorderService.stopRecording] after the GPX file has been
     * finalized so a subsequent START_STICKY restart doesn't try to
     * recover a stale recording.
     */
    fun clearPersistedState() {
        val prefs = service.getSharedPreferences(GpsRecorderService.PREFS_NAME, Context.MODE_PRIVATE).edit()
        prefs.clear()
        prefs.apply()
    }

    /**
     * START_STICKY recovery: reads the persisted recording state, reloads
     * buffered points from the temp file (multi-segment aware), restores
     * the raw auto-pause window, restores the prev cursor (or just
     * lastFixTimeMs when auto-paused), and restarts the foreground
     * notification.
     *
     * L19 invariant: re-registers the foreground notification BEFORE
     * returning so Android sees the service as foreground within 100 ms
     * of onCreate() returning. Previously the notification was only
     * started later in onStartCommand — between onCreate and
     * onStartCommand, `isRecording` was true but no foreground state was
     * held, so Android could kill the service again. Safe because onCreate
     * runs on the main thread before onStartCommand.
     *
     * Task 1 invariant: the auto-pause resume grace window is restored
     * from prefs, but reset to 0L if it has already expired.
     *
     * Task 2 invariant: the moving-confirmation counter is restored from
     * prefs so a restart mid-confirmation doesn't lose progress (the user
     * still has to reach MOVING_CONFIRMATION_THRESHOLD to resume).
     */
    fun recoverStateIfAny() {
        val prefs = service.getSharedPreferences(GpsRecorderService.PREFS_NAME, Context.MODE_PRIVATE)
        if (prefs.getBoolean(GpsRecorderService.KEY_IS_RECORDING, false)) {
            service.isRecording = true
            service.startTimeMs = prefs.getLong(GpsRecorderService.KEY_START_TIME, System.currentTimeMillis())
            service.pointCount = prefs.getInt(GpsRecorderService.KEY_POINT_COUNT, 0)
            service.tempFileName = prefs.getString(GpsRecorderService.KEY_TEMP_FILE_NAME, null)
            service.tempFileBuffer.tempFileName = service.tempFileName
            service.totalDistanceM = prefs.getString(GpsRecorderService.KEY_TOTAL_DISTANCE, "0")?.toDoubleOrNull() ?: 0.0
            // Phase 1/3/4: recover auto-pause / signal-lost / moving-time.
            service.isAutoPaused = prefs.getBoolean(GpsRecorderService.KEY_IS_AUTO_PAUSED, false)
            service.signalLost = prefs.getBoolean(GpsRecorderService.KEY_SIGNAL_LOST, false)
            service.movingMs = prefs.getLong(GpsRecorderService.KEY_MOVING_MS, 0L)
            // CODE_REVIEW_TODO Task 1: recover the auto-pause resume grace
            // window. If the grace has already expired by the time we
            // recover, reset it to 0L so the gap watchdog / gap-recovery
            // branch can fire normally again. (A service restart that
            // happens mid-grace will still honor the remaining window —
            // this is the safe choice because the race the grace protects
            // against is most acute in the first few seconds after resume.)
            val recoveredGrace = prefs.getLong(GpsRecorderService.KEY_AUTO_PAUSE_RESUME_GRACE_UNTIL_MS, 0L)
            service.autoPauseResumeGraceUntilMs =
                if (recoveredGrace > 0L && recoveredGrace > System.currentTimeMillis()) recoveredGrace else 0L
            // CODE_REVIEW_TODO Task 2: recover the moving-confirmation counter.
            // If we were auto-paused when the service was killed, the
            // counter is whatever it was at the last persistAutoPauseState()
            // call. We keep it so the user doesn't have to start over (but
            // they still need to reach MOVING_CONFIRMATION_THRESHOLD
            // consecutive fast fixes to resume).
            service.consecutiveMovingFixes = prefs.getInt(GpsRecorderService.KEY_CONSECUTIVE_MOVING_FIXES, 0)
            // If we were not auto-paused when the service was killed, treat
            // the resume instant as the start of a new moving segment so
            // movingMs accumulates correctly going forward. (If we were
            // auto-paused, lastResumeMs stays null — it will be set when
            // the user resumes.)
            service.lastResumeMs = if (!service.isAutoPaused) System.currentTimeMillis() else null
            Log.i(
                tag,
                "Recovered recording state: start=${service.startTimeMs} count=${service.pointCount}" +
                    " temp=${service.tempFileName} dist=${service.totalDistanceM}" +
                    " autoPaused=${service.isAutoPaused} signalLost=${service.signalLost} movingMs=${service.movingMs}" +
                    " graceUntil=${service.autoPauseResumeGraceUntilMs}" +
                    " consecutiveMovingFixes=${service.consecutiveMovingFixes}"
            )
            // Try to reload buffered points from the temp file (multi-segment aware).
            service.tempFileBuffer.reloadPointsIntoBuffer()
            // L20 fix: restore rawWindow from the persisted JSON so auto-pause
            // detection can make a correct decision on the first fix after
            // restart (instead of waiting ~10 s for the window to fill).
            restoreRawWindow(prefs)
            // Restore prevLat/prevLon/lastFixTimeMs from the last point in the
            // last segment so distance accumulation continues smoothly after
            // a service restart. If the last segment is empty (e.g. we were
            // auto-paused when killed), use the last point of any non-empty
            // earlier segment — but in that case the user was paused, so
            // prevLat should stay null and the velocity gate will naturally
            // bypass the first post-restart fix.
            if (!service.isAutoPaused) {
                synchronized(service.segmentedBuffer.pointBufferLock) {
                    val last = service.segmentedBuffer.currentSegment.lastOrNull()
                        ?: service.segmentedBuffer.trackSegments.lastOrNull()?.lastOrNull()
                    if (last != null) {
                        service.prevLat = last.lat
                        service.prevLon = last.lon
                        service.prevTimeMs = last.timeMs
                        service.lastFixTimeMs = last.timeMs
                    }
                }
            } else {
                // Paused: don't restore prev cursor — the next fix that
                // resumes movement will go through resetValidationCursor()
                // via exitAutoPause() anyway, so starting with null is safer.
                synchronized(service.segmentedBuffer.pointBufferLock) {
                    val last = service.segmentedBuffer.currentSegment.lastOrNull()
                        ?: service.segmentedBuffer.trackSegments.lastOrNull()?.lastOrNull()
                    if (last != null) service.lastFixTimeMs = last.timeMs
                }
            }
            // L19 fix: re-register the foreground notification BEFORE
            // returning so Android sees the service as foreground within
            // 100 ms of onCreate() returning. Previously the notification
            // was only started later in onStartCommand — between onCreate
            // and onStartCommand, `isRecording` was true but no foreground
            // state was held, so Android could kill the service again.
            // Safe because onCreate runs on the main thread before
            // onStartCommand.
            service.notifier.startForegroundIfNeeded(
            GpsRecorderNotification.NotificationSnapshot(
                points = service.pointCount,
                elapsedMs = service.getElapsedMs(),
                isAutoPaused = service.isAutoPaused,
                signalLost = service.signalLost
            )
        ) {
            service.wakeLockManager.release()
            GpsRecorderModule.emitError("Не удалось запустить foreground service", fatal = true)
            service.stopSelf()
        }
        }
    }
}
