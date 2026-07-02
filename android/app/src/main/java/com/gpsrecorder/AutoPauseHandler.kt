package com.gpsrecorder

import android.util.Log

/**
 * AutoPauseHandler
 *
 * K10: extracted from [LocationChangedHandler] so that file stays under 500
 * lines. Owns the auto-pause (stop detection) phase of `onLocationChanged`.
 *
 * When auto-pause is enabled, a sliding window of the last
 * AutoPauseGapController.RAW_WINDOW_MS of raw fixes is maintained, and when
 * both instantaneous speed and maximum pairwise displacement fall below
 * their thresholds, the user is considered stationary; we enter (or stay
 * in) auto-pause and skip recording the point. When the user starts moving
 * again, a hysteresis counter requires
 * AutoPauseGapController.MOVING_CONFIRMATION_THRESHOLD consecutive "clearly
 * moving" fixes before resuming.
 *
 * The handler holds no state of its own — all state (`rawWindow`,
 * `isAutoPaused`, `consecutiveMovingFixes`, `prevLat`, `prevLon`,
 * `prevTimeMs`) remains on [GpsRecorderService] as `@Volatile internal var`s;
 * the handler reads / writes them via `service.` references so the existing
 * threading model is preserved unchanged.
 *
 * Behavior is byte-for-byte identical to the pre-K10 in-handler
 * implementation — every speed / displacement / hysteresis check, every
 * emit-on-drop, every resume-confirmation branch is preserved verbatim.
 * Only the references are rewired to go through `service.`.
 */
class AutoPauseHandler internal constructor(
    private val service: GpsRecorderService,
) {

    /**
     * Runs the auto-pause phase for [pt]. Returns `true` if the caller should
     * return from `onLocationChanged` (the fix was dropped via [emitFix] in
     * the stopped / confirmation / reset branches); `false` if the caller
     * should continue with the time-sampling / accuracy / velocity / radial
     * gates (auto-pause disabled, user moving while not paused, or resume
     * just confirmed via [AutoPauseGapController.MOVING_CONFIRMATION_THRESHOLD]
     * consecutive moving fixes).
     */
    internal fun handle(pt: GpsPoint): Boolean {
        if (!GpsRecorderSettings.isAutoPauseEnabled(service)) return false
        // Push to sliding raw window and prune entries older than the window.
        service.rawWindow.add(pt)
        val windowCutoff = pt.timeMs - AutoPauseGapController.RAW_WINDOW_MS
        while (service.rawWindow.isNotEmpty() && service.rawWindow.peek()!!.timeMs < windowCutoff) {
            service.rawWindow.poll()
        }

        // L11 fix: do NOT treat a missing speed as 'stationary'. When
        // Location.hasSpeed() is false (cold start, poor signal, some
        // devices / emulators), pt.speed is null. The previous code
        // coerced it to 0f, which made speedOk = true (stationary) and
        // contributed to false auto-pause triggers even while the user
        // was moving. We now treat a null speed as 'not stationary' so
        // the displacement check (line below) is the sole backstop —
        // exactly what we want when the GPS can't tell us our speed.
        val speedOk = pt.speed?.let { it < AutoPauseGapController.SPEED_THRESHOLD_MPS } ?: false
        val disp = service.autoPauseGap.maxDisplacementInWindow()
        val dispOk = disp < AutoPauseGapController.DISPLACEMENT_THRESHOLD_M
        val stopped = speedOk && dispOk

        if (stopped) {
            // User is stationary.
            if (!service.isAutoPaused) {
                Log.i(
                    GpsRecorderService.TAG,
                    "Auto-pause entering: speed=${pt.speed} disp=${disp}m window=${service.rawWindow.size}"
                )
                service.autoPauseGap.enterAutoPause(pt.timeMs)
            }
            // CODE_REVIEW_TODO Task 2: a stationary fix while paused
            // resets the moving-confirmation counter (the user has to
            // re-accumulate AutoPauseGapController.MOVING_CONFIRMATION_THRESHOLD consecutive
            // fast fixes to resume). enterAutoPause() also resets it,
            // but we reset here too so a slow fix during the
            // confirmation window — without re-entering pause — also
            // resets the counter.
            if (service.isAutoPaused) service.consecutiveMovingFixes = 0
            // While paused: do NOT add the point to the buffer and do NOT
            // accumulate distance. But DO update service.lastFixTimeMs and live
            // state so the UI knows we still have a fix (and isn't fooled
            // into thinking we lost signal).
            emitFix(pt)
            return true
        } else {
            // User is moving.
            if (service.isAutoPaused) {
                // CODE_REVIEW_TODO Task 2: hysteresis — require
                // AutoPauseGapController.MOVING_CONFIRMATION_THRESHOLD consecutive "clearly
                // moving" fixes before resuming. This prevents the
                // amber "АВТОПАУЗА" banner from flickering on rapid
                // pause/resume oscillation (e.g. very slow walking
                // ~0.3 m/s with GPS drift can oscillate at the 10 s
                // window boundary). Each flicker creates a new <trkseg>
                // and toggles the notification / banner — technically
                // correct but feels glitchy.
                //
                // A fix counts as "clearly moving" if EITHER:
                //   - pt.speed >= AutoPauseGapController.HYSTERESIS_SPEED_MS (primary), OR
                //   - pt.speed is null/0 AND haversine displacement
                //     from the last kept fix implies velocity >=
                //     AutoPauseGapController.HYSTERESIS_DISPLACEMENT_MPS (fallback for
                //     receivers that don't populate Location.speed).
                //
                // The first (AutoPauseGapController.MOVING_CONFIRMATION_THRESHOLD - 1)
                // confirmation fixes are dropped (same pattern as the
                // stopped branch above) so the post-pause segment
                // starts cleanly at the moment resume is confirmed.
                // This loses ~2 s of track data at each resume —
                // acceptable per Task 2.
                val speedBased = pt.speed != null && pt.speed >= AutoPauseGapController.HYSTERESIS_SPEED_MS
                val dispBased = (!speedBased && (pt.speed == null || pt.speed == 0f)) && run {
                    val pLat = service.prevLat
                    val pLon = service.prevLon
                    val pTime = service.prevTimeMs
                    if (pLat != null && pLon != null && pTime != null) {
                        val dtSec = (pt.timeMs - pTime) / 1000.0
                        if (dtSec > 0) {
                            val d = TrackMath.haversineMeters(pLat, pLon, pt.lat, pt.lon)
                            (d / dtSec) >= AutoPauseGapController.HYSTERESIS_DISPLACEMENT_MPS
                        } else false
                    } else false
                }
                if (speedBased || dispBased) {
                    service.consecutiveMovingFixes++
                    if (service.consecutiveMovingFixes >= AutoPauseGapController.MOVING_CONFIRMATION_THRESHOLD) {
                        Log.i(
                            GpsRecorderService.TAG,
                            "Auto-pause resuming after ${service.consecutiveMovingFixes} confirmation fixes:" +
                                " speed=${pt.speed} disp=${disp}m window=${service.rawWindow.size}"
                        )
                        service.autoPauseGap.exitAutoPause(pt.timeMs)
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
                            GpsRecorderService.TAG,
                            "Auto-pause confirmation ${service.consecutiveMovingFixes}/${AutoPauseGapController.MOVING_CONFIRMATION_THRESHOLD}:" +
                                " speed=${pt.speed} disp=${disp}m — staying paused"
                        )
                        emitFix(pt)
                        return true
                    }
                } else {
                    // User moved a little but not clearly enough to
                    // count toward resume confirmation. Reset the
                    // counter and stay paused. Drop the fix.
                    if (service.consecutiveMovingFixes > 0) {
                        Log.i(
                            GpsRecorderService.TAG,
                            "Auto-pause confirmation reset (was ${service.consecutiveMovingFixes}):" +
                                " speed=${pt.speed} disp=${disp}m — staying paused"
                        )
                    }
                    service.consecutiveMovingFixes = 0
                    emitFix(pt)
                    return true
                }
            }
        }
        return false
    }

    // K10: duplicated from LocationChangedHandler.emitFix so this class can
    // run standalone (LocationChangedHandler keeps its own copy for its
    // emitDroppedFix helper). The two copies are byte-for-byte identical;
    // consolidating them into a shared FixEmitter is left as future work.
    private fun emitFix(pt: GpsPoint) {
        service.lastFixTimeMs = pt.timeMs
        service.stateRepository.saveLiveState(pt)
        GpsEventEmitter.emitLocation(
            pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
            service.locationSource.computeFixType(service.lastFixTimeMs), service.totalDistanceM, pt.timeMs, service.pointCount,
            service.isAutoPaused, service.signalLost, service.autoPauseGap.liveMovingMs(pt.timeMs)
        )
    }
}
