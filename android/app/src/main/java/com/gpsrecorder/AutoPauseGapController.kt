package com.gpsrecorder

import android.content.Context
import android.util.Log

/**
 * K6 — Auto-pause + gap-detection state machine extracted from
 * GpsRecorderService.kt.
 *
 * Encapsulates the Phase 3 / Phase 4 / Phase 6 state machine that
 * previously lived inline in [GpsRecorderService]:
 *   - [enterAutoPause] — freezes recording on stop detection.
 *   - [exitAutoPause] — resumes recording after hysteresis-confirmed
 *     movement, sets the resume grace window, and refreshes
 *     `lastFixTimeMs` so the gap watchdog doesn't fire falsely.
 *   - [handleGapRecovery] — splits the track into a new segment after a
 *     signal-loss gap is recovered.
 *   - [liveMovingMs] — the live moving-time accumulator read by every
 *     emit / save / state-poll path.
 *   - [resetValidationCursor] — nullifies the prev-fix cursor so the
 *     velocity / distance gates bypass the first fix after a transition.
 *   - [maxDisplacementInWindow] — max pairwise haversine distance inside
 *     the sliding raw window (stop-detection helper).
 *   - [persistAutoPauseState] — writes the live auto-pause / signal-lost /
 *     moving-time / grace / counter state to SharedPreferences so it
 *     survives START_STICKY restarts.
 *   - [reset] — fresh-recording start: clears every flag and resets the
 *     moving-time accumulator.
 *
 * STATE OWNERSHIP: per the K6 design (see CHANGELOG / task description),
 * the actual state fields stay on the service as `@Volatile internal var`
 * so the 470-line `onLocationChanged` method can read/write them directly
 * without changing hundreds of references. This controller's methods
 * operate on those fields via `service.` references — identical behavior
 * to the original inline implementation, just relocated.
 *
 * Invariants preserved VERBATIM from the inline implementation:
 *
 *   - Task 1 (auto-pause resume grace window): [exitAutoPause] sets
 *     `autoPauseResumeGraceUntilMs = now + GAP_THRESHOLD_MS` AND refreshes
 *     `lastFixTimeMs = now`. The grace window suppresses both the gap
 *     watchdog (durationTick) and the gap-recovery branch
 *     (onLocationChanged) for GAP_THRESHOLD_MS after every resume so a
 *     stale `lastFixTimeMs` (left over from when the user was stationary)
 *     can't trigger a false `signalLost` declaration or a spurious segment
 *     split.
 *
 *   - Task 2 (moving-confirmation hysteresis): [enterAutoPause] resets
 *     `consecutiveMovingFixes = 0`; [exitAutoPause] also resets it. A
 *     resume requires MOVING_CONFIRMATION_THRESHOLD (3) consecutive
 *     "clearly moving" fixes, checked in `onLocationChanged`.
 *
 *   - [enterAutoPause]: clears `signalLost` (stationary users have no
 *     incoming fixes by design — showing the signal-lost banner on top
 *     of the auto-pause banner would be contradictory), freezes
 *     `movingMs` (commits the delta from `lastResumeMs` up to `now`),
 *     resets the validation cursor + counter, and starts a new segment.
 *
 *   - [liveMovingMs] returns the committed `movingMs` plus the delta
 *     since `lastResumeMs` when the user is actively moving (not paused
 *     and not signal-lost). When paused or signal-lost, returns the
 *     frozen `movingMs`.
 *
 *   - [handleGapRecovery] resumes moving-time accumulation from `now`
 *     (the gap watchdog froze it at the last fix; if the user is
 *     stationary the auto-pause path below will immediately re-freeze
 *     via [enterAutoPause]).
 */
class AutoPauseGapController(private val service: GpsRecorderService) {

    // ------------------------------------------------------------------
    // Validation cursor (Phase 3 helper)
    // ------------------------------------------------------------------

    /**
     * Nullifies the prev-fix cursor used by the velocity / distance gates.
     * Called on auto-pause transitions and gap-recovery events so the next
     * accepted fix isn't validated against a stale previous point (which
     * would either be dropped by the velocity gate or inflate the distance
     * with a straight-line jump across the pause / gap).
     */
    fun resetValidationCursor() {
        service.prevLat = null
        service.prevLon = null
        service.prevTimeMs = null
    }

    // ------------------------------------------------------------------
    // Stop-detection helper (Phase 3)
    // ------------------------------------------------------------------

    /**
     * Returns the maximum pairwise Haversine distance (in meters) between
     * any two points in the sliding raw window. Used by auto-pause to confirm
     * that the user is actually standing still (and not just momentarily
     * slow at the start of a sprint).
     *
     * O(n^2) in the window size — at 1 Hz over 10 s that's ~45 comparisons,
     * which is negligible.
     */
    fun maxDisplacementInWindow(): Double {
        // Take a snapshot under no lock (rawWindow is only touched on the
        // main thread by onLocationChanged, so this is safe).
        val pts = ArrayList<GpsPoint>(service.rawWindow)
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

    // ------------------------------------------------------------------
    // Live-state persistence
    // ------------------------------------------------------------------

    /**
     * Persists the auto-pause / signal-lost / moving-time live state to
     * SharedPreferences so it survives service restarts and can be polled
     * via getState(). Called whenever these flags change (whether or not a
     * new fix arrived).
     */
    fun persistAutoPauseState() {
        try {
            service.getSharedPreferences(GpsRecorderService.PREFS_NAME, Context.MODE_PRIVATE).edit()
                .putBoolean(GpsRecorderService.KEY_IS_AUTO_PAUSED, service.isAutoPaused)
                .putBoolean(GpsRecorderService.KEY_SIGNAL_LOST, service.signalLost)
                .putLong(GpsRecorderService.KEY_MOVING_MS, service.movingMs)
                // CODE_REVIEW_TODO Task 1: persist the grace window here too
                // so a service restart mid-grace still honors it.
                .putLong(GpsRecorderService.KEY_AUTO_PAUSE_RESUME_GRACE_UNTIL_MS, service.autoPauseResumeGraceUntilMs)
                // CODE_REVIEW_TODO Task 2: persist the moving-confirmation
                // counter so a service restart mid-confirmation doesn't
                // lose progress.
                .putInt(GpsRecorderService.KEY_CONSECUTIVE_MOVING_FIXES, service.consecutiveMovingFixes)
                .apply()
        } catch (e: Exception) {
            Log.w(GpsRecorderService.TAG, "persistAutoPauseState failed", e)
        }
    }

    // ------------------------------------------------------------------
    // Auto-pause transitions
    // ------------------------------------------------------------------

    /**
     * Enters auto-pause: stops recording points, finalizes the current
     * segment so the post-pause segment is distinct, freezes the moving-time
     * accumulator, and updates the foreground notification.
     *
     * Also clears `signalLost`: stationary users legitimately have no
     * incoming fixes, so showing the signal-lost banner on top of the
     * auto-pause banner would be contradictory. See CHANGELOG.md.
     */
    fun enterAutoPause(now: Long) {
        service.isAutoPaused = true
        service.signalLost = false
        resetValidationCursor()
        service.segmentedBuffer.createNewSegment()
        // Freeze the moving-time accumulator.
        service.lastResumeMs?.let { r ->
            if (now > r) service.movingMs += (now - r)
        }
        service.lastResumeMs = null
        // CODE_REVIEW_TODO Task 2: reset the moving-confirmation counter so
        // the next resume requires a fresh run of MOVING_CONFIRMATION_THRESHOLD
        // consecutive fast fixes.
        service.consecutiveMovingFixes = 0
        persistAutoPauseState()
        service.notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = service.pointCount,
                elapsedMs = service.getElapsedMs(),
                isAutoPaused = service.isAutoPaused,
                signalLost = service.signalLost
            )
        )
        Log.i(GpsRecorderService.TAG, "Auto-pause entered at $now (movingMs=${service.movingMs})")
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
    fun exitAutoPause(now: Long) {
        service.isAutoPaused = false
        resetValidationCursor()
        service.segmentedBuffer.createNewSegment()  // no-op if currentSegment is empty (typical case)
        service.lastResumeMs = now
        // CODE_REVIEW_TODO Task 1: grace window + lastFixTimeMs refresh.
        service.autoPauseResumeGraceUntilMs = now + GpsRecorderService.GAP_THRESHOLD_MS
        service.lastFixTimeMs = now
        // CODE_REVIEW_TODO Task 2: reset the moving-confirmation counter so
        // the next auto-pause cycle starts fresh.
        service.consecutiveMovingFixes = 0
        persistAutoPauseState()
        service.notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = service.pointCount,
                elapsedMs = service.getElapsedMs(),
                isAutoPaused = service.isAutoPaused,
                signalLost = service.signalLost
            )
        )
        Log.i(
            GpsRecorderService.TAG,
            "Auto-pause exited at $now (movingMs=${service.movingMs}, graceUntil=${service.autoPauseResumeGraceUntilMs})"
        )
    }

    // ------------------------------------------------------------------
    // Gap recovery (Phase 4)
    // ------------------------------------------------------------------

    /**
     * Handles gap recovery: called inside onLocationChanged when a new fix
     * arrives after a signal gap (> GAP_THRESHOLD_MS since the last fix, or
     * when the watchdog has already declared signalLost). Splits the track
     * into a new segment and resets the validation cursor so the velocity
     * gate doesn't compare across the gap. Distance across the gap is NOT
     * added to totalDistanceM (prevLat is null after reset).
     *
     * Also resumes the moving-time accumulator from `now`. While the gap
     * was active the watchdog froze movingMs (see [durationTick]); now that a
     * fix has arrived we resume accumulating. If the user is actually
     * stationary, the auto-pause path further down in onLocationChanged
     * will immediately re-freeze movingMs via enterAutoPause(), so this is
     * safe. See CHANGELOG.md.
     */
    fun handleGapRecovery(now: Long) {
        resetValidationCursor()
        service.segmentedBuffer.createNewSegment()
        service.signalLost = false
        // Resume moving-time accumulation from this instant. If the user
        // is stationary, the auto-pause path below will immediately freeze
        // it again via enterAutoPause(now) — net effect: zero gap time
        // leaks into movingMs, and a stationary post-gap user still gets
        // correctly auto-paused.
        service.lastResumeMs = now
        persistAutoPauseState()
        service.notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = service.pointCount,
                elapsedMs = service.getElapsedMs(),
                isAutoPaused = service.isAutoPaused,
                signalLost = service.signalLost
            )
        )
        Log.i(GpsRecorderService.TAG, "Gap recovered at $now — new segment started, movingMs accumulation resumed")
    }

    // ------------------------------------------------------------------
    // Live moving time (Phase 6)
    // ------------------------------------------------------------------

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
    fun liveMovingMs(now: Long = System.currentTimeMillis()): Long {
        if (service.isAutoPaused || service.signalLost) return service.movingMs
        val r = service.lastResumeMs ?: return service.movingMs
        val delta = now - r
        return if (delta > 0L) service.movingMs + delta else service.movingMs
    }

    // ------------------------------------------------------------------
    // Fresh-recording reset
    // ------------------------------------------------------------------

    /**
     * Resets all auto-pause + gap-detection + moving-time state for a
     * fresh recording start (user pressed START). Called from
     * [GpsRecorderService.startRecording] on the non-resume path right
     * after `startTimeMs` has been set, so `lastResumeMs = startTimeMs`
     * is well-defined.
     *
     * Invariants preserved verbatim from the original inline block:
     *   - isAutoPaused / signalLost → false
     *   - rawWindow → cleared
     *   - movingMs → 0L
     *   - lastResumeMs → startTimeMs (so the first fix's moving-time
     *     delta is measured from the start of the recording)
     *   - autoPauseResumeGraceUntilMs → 0L (Task 1: a fresh recording
     *     doesn't inherit a stale grace from a previous session)
     *   - consecutiveMovingFixes → 0 (Task 2: hysteresis window starts
     *     from 0)
     */
    fun reset() {
        service.isAutoPaused = false
        service.signalLost = false
        service.rawWindow.clear()
        // Phase 6: reset moving-time accumulator.
        service.movingMs = 0L
        service.lastResumeMs = service.startTimeMs
        // CODE_REVIEW_TODO Task 1: reset the auto-pause resume grace
        // window so a fresh recording doesn't inherit a stale grace
        // from a previous session.
        service.autoPauseResumeGraceUntilMs = 0L
        // CODE_REVIEW_TODO Task 2: reset the moving-confirmation counter
        // so a fresh recording starts the hysteresis window from 0.
        service.consecutiveMovingFixes = 0
    }
}
