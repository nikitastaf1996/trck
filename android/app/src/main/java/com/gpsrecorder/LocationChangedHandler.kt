package com.gpsrecorder

import android.location.Location
import android.location.LocationListener
import android.os.Bundle
import android.util.Log

/**
 * LocationChangedHandler
 *
 * K7: extracted from `GpsRecorderService.kt` so the service file stays under
 * 1000 lines. Owns the 470-line `onLocationChanged` callback (8 filter stages:
 * stale-fix, gap-detection / recovery, auto-pause enter / exit hysteresis,
 * time-sampling, accuracy, velocity, radial-distance, raw-mode distance
 * accumulator) and the `accumulateDistance` helper.
 *
 * Implements [LocationListener] so the service can delegate its four
 * LocationListener overrides here (`onLocationChanged`,
 * `onProviderEnabled`, `onProviderDisabled`, `onStatusChanged`).
 *
 * The handler holds no GPS / recording state of its own except
 * [timeSamplingCounter] (per-recording, reset in `startRecording()`). All
 * other state — `isRecording`, `prevLat` / `prevLon` / `prevTimeMs`,
 * `totalDistanceM`, `lastFixTimeMs`, `isAutoPaused`, `signalLost`, `movingMs`,
 * `lastResumeMs`, `autoPauseResumeGraceUntilMs`, `consecutiveMovingFixes`,
 * `rawWindow`, `pointCount` — remains on [GpsRecorderService] as
 * `@Volatile internal var`s; the handler reads / writes them via `service.`
 * references so the existing threading model is preserved unchanged.
 *
 * Constants (`ACCURACY_THRESHOLD_M`, `MAX_FIX_AGE_MS`, `MAX_VELOCITY_MPS`,
 * `MIN_VELOCITY_GATE_DT_SEC`, `GAP_THRESHOLD_MS`, `AUTO_PAUSE_*`,
 * `MOVING_CONFIRMATION_THRESHOLD`, `HYSTERESIS_*`, `TAG`) stay on the service
 * companion object; the handler accesses them via `GpsRecorderService.X`.
 * Settings reads go through [GpsRecorderSettings] directly (passing the
 * service as the `Context`). Threshold getters
 * (`getRadialDistanceThresholdM`, `getTimeSamplingN`) remain on the service
 * (made `internal` for K7) and are called via `service.X()`.
 *
 * Behavior is byte-for-byte identical to the pre-K7 in-service implementation
 * — every filter stage, every emit-on-drop pattern, every accuracy / velocity
 * / radial / time-sampling gate is preserved verbatim. Only the references
 * are rewired to go through `service.` / `GpsRecorderService.` /
 * `GpsRecorderSettings.`.
 */
class LocationChangedHandler internal constructor(
    private val service: GpsRecorderService,
) : LocationListener {

    companion object {
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

        // ---- L22: minimum dt for velocity gate ----
        // GPS receivers occasionally emit two fixes within 50–200 ms of
        // each other. A normal 1.4 m/s walk over 100 ms yields 14 m/s,
        // exceeding the 20 km/h ceiling and getting the fix dropped. The
        // velocity gate is bypassed for dt < MIN_VELOCITY_GATE_DT_SEC
        // — the displacement is too small to produce a reliable velocity.
        // dt <= 0 (duplicate timestamp) is still dropped.
        internal const val MIN_VELOCITY_GATE_DT_SEC = 0.5
    }

    // ---- Time-sampling on-the-fly filter state ----
    // Monotonic counter incremented for EVERY fix that arrives (after the
    // stale-fix / gap / auto-pause checks). When `time_sampling_enabled` is
    // on, only fixes where `(counter % N == 0)` are kept; the rest are
    // dropped before any other gate runs. Reset to 0 in `startRecording()`
    // (via `service.locationHandler.timeSamplingCounter = 0`) so each
    // recording starts a fresh sampling window. Not persisted across service
    // restarts — a restart simply begins a new window.
    @Volatile internal var timeSamplingCounter: Int = 0

    override fun onLocationChanged(location: Location) {
        if (!service.isRecording) return
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
        // such a fix would poison service.prevLat/service.prevLon and inflate service.totalDistanceM on
        // the next fresh fix. This is the second half of the "starts with 9 m /
        // 69 m" fix (the first half is removing the getLastKnownLocation() seed).
        val fixAgeMs = System.currentTimeMillis() - pt.timeMs
        if (fixAgeMs > MAX_FIX_AGE_MS) {
            // L33 fix: downgrade to SafeLog.d and strip lat/lon — this was
            // the only Log.w call in the service that leaked GPS coordinates
            // in release builds.
            SafeLog.d(GpsRecorderService.TAG, "Dropping stale fix: age=${fixAgeMs}ms")
            return
        }

        // ---- Phase 4: Gap detection (signal loss) ----
        // If this fix arrived more than AutoPauseGapController.GAP_THRESHOLD_MS after the previous one,
        // OR if the watchdog has already declared service.signalLost, treat this as gap
        // recovery: split the track into a new segment and reset the validation
        // cursor so the velocity gate doesn't compare across the gap. Distance
        // across the gap is NOT added to service.totalDistanceM (service.prevLat is null after
        // reset, so both the velocity gate and accumulateDistance skip it).
        //
        // Gated on the gap_detection_enabled setting. When the user has
        // disabled gap detection, we skip the segment-split entirely (the
        // next fix is appended to the current segment, and the velocity
        // gate will compare it against the pre-gap point — the legacy pre-
        // Phase-4 behaviour). service.signalLost can only be true at this point if
        // the watchdog declared it while the setting was on, so even when
        // the setting has just been toggled off mid-recording we still
        // honor a previously-declared service.signalLost by clearing it without
        // splitting the segment.
        //
        // Skip this block while auto-paused: stationary users have no
        // incoming fixes by design, and the current segment was already
        // finalized on auto-pause entry. Running handleGapRecovery here
        // would create spurious 1-point segments in the GPX. See CHANGELOG.md.
        //
        // CODE_REVIEW_TODO Task 1: also skip while inside the auto-pause
        // resume grace window. The resume fix itself arrives with
        // service.isAutoPaused already flipped to false (exitAutoPause ran earlier
        // in this same onLocationChanged call), so without the grace check
        // this branch would compare `pt.timeMs - service.lastFixTimeMs` (which
        // exitAutoPause just refreshed to `pt.timeMs`, so the diff is 0)
        // — but on the NEXT fix, if the user stood still for ~25 s before
        // resuming, service.lastFixTimeMs may still point to a stale pre-pause
        // value and the diff would exceed AutoPauseGapController.GAP_THRESHOLD_MS, falsely
        // triggering a segment split. The grace check makes the invariant
        // explicit.
        if (GpsRecorderSettings.isGapDetectionEnabled(service) && !service.isAutoPaused
            && pt.timeMs >= service.autoPauseResumeGraceUntilMs   // Task 1
        ) {
            val gapDetected = service.lastFixTimeMs > 0L && (pt.timeMs - service.lastFixTimeMs) > AutoPauseGapController.GAP_THRESHOLD_MS
            if (gapDetected || service.signalLost) {
                Log.i(
                    GpsRecorderService.TAG,
                    "Gap recovery: gapSinceLast=${if (service.lastFixTimeMs > 0L) pt.timeMs - service.lastFixTimeMs else -1}ms" +
                        " signalLostWas=${service.signalLost}"
                )
                service.autoPauseGap.handleGapRecovery(pt.timeMs)
            }
        } else if (service.signalLost) {
            // Setting was toggled off after the watchdog declared service.signalLost,
            // OR we're auto-paused (in which case the watchdog should not have
            // fired — but be defensive). Clear the flag without splitting the
            // segment so the UI banner dismisses itself, but the track keeps
            // its current segment structure.
            service.signalLost = false
            service.autoPauseGap.persistAutoPauseState()
            service.notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = service.pointCount,
                elapsedMs = service.getElapsedMs(),
                isAutoPaused = service.isAutoPaused,
                signalLost = service.signalLost
            )
        )
            Log.i(GpsRecorderService.TAG, "Gap detection disabled or auto-paused — clearing service.signalLost flag")
        }

        // ---- Phase 3: Auto-pause (stop detection) ----
        // When enabled, we maintain a sliding window of the last
        // AutoPauseGapController.RAW_WINDOW_MS of raw fixes and check two conditions:
        //   1. Instantaneous speed < AutoPauseGapController.SPEED_THRESHOLD_MPS
        //   2. Maximum pairwise displacement in the window < AutoPauseGapController.DISPLACEMENT_THRESHOLD_M
        // If both are true, the user is considered stationary; we enter (or
        // stay in) auto-pause and skip recording the point. When the user
        // starts moving again, we exit auto-pause and start a new segment.
        if (GpsRecorderSettings.isAutoPauseEnabled(service)) {
            // Push to sliding raw window and prune entries older than the window.
            service.rawWindow.add(pt)
            val windowCutoff = pt.timeMs - AutoPauseGapController.RAW_WINDOW_MS
            while (service.rawWindow.isNotEmpty() && service.rawWindow.peek().timeMs < windowCutoff) {
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
                service.lastFixTimeMs = pt.timeMs
                service.stateRepository.saveLiveState(pt)
                GpsEventEmitter.emitLocation(
                    pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                    service.locationSource.computeFixType(service.lastFixTimeMs), service.totalDistanceM, pt.timeMs, service.pointCount,
                    service.isAutoPaused, service.signalLost, service.autoPauseGap.liveMovingMs(pt.timeMs)
                )
                return
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
                            service.lastFixTimeMs = pt.timeMs
                            service.stateRepository.saveLiveState(pt)
                            GpsEventEmitter.emitLocation(
                                pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                                service.locationSource.computeFixType(service.lastFixTimeMs), service.totalDistanceM, pt.timeMs, service.pointCount,
                                service.isAutoPaused, service.signalLost, service.autoPauseGap.liveMovingMs(pt.timeMs)
                            )
                            return
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
                        service.lastFixTimeMs = pt.timeMs
                        service.stateRepository.saveLiveState(pt)
                        GpsEventEmitter.emitLocation(
                            pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                            service.locationSource.computeFixType(service.lastFixTimeMs), service.totalDistanceM, pt.timeMs, service.pointCount,
                            service.isAutoPaused, service.signalLost, service.autoPauseGap.liveMovingMs(pt.timeMs)
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
        // service.lastFixTimeMs + saveLiveState + emit before returning. This keeps the
        // UI's lastFix display current and prevents the gap watchdog from
        // falsely firing (since service.lastFixTimeMs advances on every fix, kept or
        // dropped).
        //
        // The counter is reset to 0 in startRecording() and incremented for
        // every fix that reaches this point. The first fix of a recording
        // (counter == 1 after the increment below) is ALWAYS kept so the
        // track has a starting point even when N > 1.
        if (GpsRecorderSettings.isTimeSamplingEnabled(service)) {
            timeSamplingCounter++
            val n = service.getTimeSamplingN().coerceAtLeast(1)
            val keep = (n == 1) || (timeSamplingCounter == 1) || (timeSamplingCounter % n == 0)
            if (!keep) {
                SafeLog.d(GpsRecorderService.TAG, "Time sampling: dropping fix #${timeSamplingCounter} (n=$n)")
                service.lastFixTimeMs = pt.timeMs
                service.stateRepository.saveLiveState(pt)
                GpsEventEmitter.emitLocation(
                    pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                    service.locationSource.computeFixType(service.lastFixTimeMs), service.totalDistanceM, pt.timeMs, service.pointCount,
                    service.isAutoPaused, service.signalLost, service.autoPauseGap.liveMovingMs(pt.timeMs)
                )
                service.notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = service.pointCount,
                elapsedMs = service.getElapsedMs(),
                isAutoPaused = service.isAutoPaused,
                signalLost = service.signalLost
            )
        )
                return
            }
        }

        if (GpsRecorderSettings.isPostProcessEnabled(service)) {
            // B. Accuracy gate: skip fixes whose reported accuracy is worse than the
            // threshold. These are almost always multipath or cold-start noise.
            //
            // L4 fix: dropped fixes MUST still advance service.lastFixTimeMs, save live
            // state, and emit a location event — same pattern the time-sampling
            // drop (above) and the radial filter drop (below) use. Without this
            // the UI's lastFix display freezes for the dropped fix, the gap
            // watchdog falsely fires 'service.signalLost' after 15 s of dropped fixes,
            // and getState() polling returns stale data.
            //
            // We do NOT advance service.prevLat/service.prevLon — these are dropped fixes and
            // must not become the reference for the next fix's velocity /
            // distance computation.
            val acc = pt.accuracy
            if (acc != null && acc > ACCURACY_THRESHOLD_M) {
                SafeLog.d(GpsRecorderService.TAG, "On-the-fly filter: dropping low-accuracy fix (acc=${acc}m)")
                service.lastFixTimeMs = pt.timeMs
                service.stateRepository.saveLiveState(pt)
                GpsEventEmitter.emitLocation(
                    pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                    service.locationSource.computeFixType(service.lastFixTimeMs), service.totalDistanceM, pt.timeMs, service.pointCount,
                    service.isAutoPaused, service.signalLost, service.autoPauseGap.liveMovingMs(pt.timeMs)
                )
                service.notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = service.pointCount,
                elapsedMs = service.getElapsedMs(),
                isAutoPaused = service.isAutoPaused,
                signalLost = service.signalLost
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
            // NOTE: service.prevLat is null after a resetValidationCursor() call (auto-
            // pause resume / gap recovery), so this gate is naturally bypassed
            // for the first fix after such a transition — exactly what we want,
            // since that fix has no meaningful "previous" to compare against.
            //
            // L4 fix (see accuracy gate above): the zero-dt and velocity drops
            // also mirror the time-sampling drop pattern so the UI stays fresh
            // and the gap watchdog doesn't fire falsely.
            var distanceToAdd = 0.0
            val pLat = service.prevLat
            val pLon = service.prevLon
            val pTime = service.prevTimeMs
            if (pLat != null && pLon != null && pTime != null) {
                val dtSec = (pt.timeMs - pTime) / 1000.0
                if (dtSec <= 0.0) {
                    SafeLog.d(GpsRecorderService.TAG, "On-the-fly filter: dropping zero-dt fix (dt=${dtSec}s)")
                    service.lastFixTimeMs = pt.timeMs
                    service.stateRepository.saveLiveState(pt)
                    GpsEventEmitter.emitLocation(
                        pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                        service.locationSource.computeFixType(service.lastFixTimeMs), service.totalDistanceM, pt.timeMs, service.pointCount,
                        service.isAutoPaused, service.signalLost, service.autoPauseGap.liveMovingMs(pt.timeMs)
                    )
                    service.notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = service.pointCount,
                elapsedMs = service.getElapsedMs(),
                isAutoPaused = service.isAutoPaused,
                signalLost = service.signalLost
            )
        )
                    return
                }
                val d = TrackMath.haversineMeters(pLat, pLon, pt.lat, pt.lon)
                if (dtSec >= MIN_VELOCITY_GATE_DT_SEC) {
                    val velocityMps = d / dtSec
                    if (velocityMps > MAX_VELOCITY_MPS) {
                        SafeLog.d(GpsRecorderService.TAG, "On-the-fly filter: dropping velocity outlier (v=${velocityMps}m/s d=${d}m dt=${dtSec}s)")
                        service.lastFixTimeMs = pt.timeMs
                        service.stateRepository.saveLiveState(pt)
                        GpsEventEmitter.emitLocation(
                            pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                            service.locationSource.computeFixType(service.lastFixTimeMs), service.totalDistanceM, pt.timeMs, service.pointCount,
                            service.isAutoPaused, service.signalLost, service.autoPauseGap.liveMovingMs(pt.timeMs)
                        )
                        service.notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = service.pointCount,
                elapsedMs = service.getElapsedMs(),
                isAutoPaused = service.isAutoPaused,
                signalLost = service.signalLost
            )
        )
                        return
                    }
                }
                distanceToAdd = d
                // ---- Radial-distance on-the-fly filter (independent toggle) ----
                // Drops the candidate if it is closer than threshold meters to
                // the last KEPT point (which is what service.prevLat/service.prevLon currently
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
                // still "fresh" (good GPS), so we update service.lastFixTimeMs +
                // saveLiveState + emit before returning — same pattern as the
                // time-sampling drop above.
                //
                // Stage distanceToAdd in a local and only commit to
                // service.totalDistanceM *after* the radial filter check passes, so
                // the cursor and the accumulator always advance together
                // (otherwise dropped fixes would double-count their step
                // distance). See CHANGELOG.md.
                if (GpsRecorderSettings.isRadialDistanceFilterEnabled(service)) {
                    val threshold = service.getRadialDistanceThresholdM().toDouble()
                    if (d < threshold) {
                        SafeLog.d(GpsRecorderService.TAG, "Radial filter: dropping too-close fix (d=${d}m < ${threshold}m)")
                        service.lastFixTimeMs = pt.timeMs
                        service.stateRepository.saveLiveState(pt)
                        GpsEventEmitter.emitLocation(
                            pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                            service.locationSource.computeFixType(service.lastFixTimeMs), service.totalDistanceM, pt.timeMs, service.pointCount,
                            service.isAutoPaused, service.signalLost, service.autoPauseGap.liveMovingMs(pt.timeMs)
                        )
                        service.notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = service.pointCount,
                elapsedMs = service.getElapsedMs(),
                isAutoPaused = service.isAutoPaused,
                signalLost = service.signalLost
            )
        )
                        return
                    }
                }
            }
            // D. Point passed both gates — commit it to the current segment and
            // advance the previous-fix cursor.
            // Accumulate only after confirming the point passes the radial
            // filter, so dropped fixes don't leak distance into service.totalDistanceM.
            service.totalDistanceM += distanceToAdd
            service.pointCount = service.segmentedBuffer.appendPointToCurrentSegment(pt)
            service.prevLat = pt.lat
            service.prevLon = pt.lon
            service.prevTimeMs = pt.timeMs
            service.lastFixTimeMs = pt.timeMs
        } else {
            // ---- Radial-distance on-the-fly filter (raw mode) ----
            // Same logic as in the post_process branch above, but we have to
            // compute the haversine ourselves because the velocity gate runs
            // inside accumulateDistance() and we don't have a `d` in scope.
            // We check against service.prevLat (last KEPT point) before appending.
            //
            // L29 fix: when the radial filter is enabled, we compute `d` here
            // and pass it to accumulateDistance() via the new
            // `precomputedDistanceM` parameter — eliminating the duplicate
            // haversine call that the previous version made inside
            // accumulateDistance(). When the radial filter is disabled, we
            // pass null and let accumulateDistance() compute `d` itself.
            var precomputedD: Double? = null
            if (GpsRecorderSettings.isRadialDistanceFilterEnabled(service)) {
                val pLat = service.prevLat
                val pLon = service.prevLon
                if (pLat != null && pLon != null) {
                    val d = TrackMath.haversineMeters(pLat, pLon, pt.lat, pt.lon)
                    precomputedD = d
                    val threshold = service.getRadialDistanceThresholdM().toDouble()
                    if (d < threshold) {
                        SafeLog.d(GpsRecorderService.TAG, "Radial filter (raw): dropping too-close fix (d=${d}m < ${threshold}m)")
                        service.lastFixTimeMs = pt.timeMs
                        service.stateRepository.saveLiveState(pt)
                        GpsEventEmitter.emitLocation(
                            pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
                            service.locationSource.computeFixType(service.lastFixTimeMs), service.totalDistanceM, pt.timeMs, service.pointCount,
                            service.isAutoPaused, service.signalLost, service.autoPauseGap.liveMovingMs(pt.timeMs)
                        )
                        service.notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = service.pointCount,
                elapsedMs = service.getElapsedMs(),
                isAutoPaused = service.isAutoPaused,
                signalLost = service.signalLost
            )
        )
                        return
                    }
                }
            }
            // E. Fallback: record every fix raw so the GPX file keeps the noisy
            // data, but still keep the displayed distance sane by routing the
            // accuracy/velocity gates through the distance accumulator only.
            service.pointCount = service.segmentedBuffer.appendPointToCurrentSegment(pt)
            accumulateDistance(pt, precomputedD)
            service.lastFixTimeMs = pt.timeMs
        }
        // Save current state to SharedPreferences so JS can poll via getState()
        // even if the event emitter is not delivering events reliably.
        service.stateRepository.saveLiveState(pt)
        // Emit the event with service.pointCount + auto-pause / signal state so the JS
        // UI can reflect pause / gap status in real time.
        //
        // Emit liveMovingMs(pt.timeMs): the frozen movingMs field is only
        // updated at auto-pause transitions, so between transitions it would
        // make the displayed avg pace wildly off. liveMovingMs adds the time
        // elapsed since the last resume so the value tracks the actual walk
        // second-by-second. See CHANGELOG.md.
        GpsEventEmitter.emitLocation(
            pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
            service.locationSource.computeFixType(service.lastFixTimeMs), service.totalDistanceM, pt.timeMs, service.pointCount,
            service.isAutoPaused, service.signalLost, service.autoPauseGap.liveMovingMs(pt.timeMs)
        )
        service.notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = service.pointCount,
                elapsedMs = service.getElapsedMs(),
                isAutoPaused = service.isAutoPaused,
                signalLost = service.signalLost
            )
        )
    }

    private fun accumulateDistance(pt: GpsPoint, precomputedDistanceM: Double? = null) {
        val acc = pt.accuracy
        if (acc != null && acc > ACCURACY_THRESHOLD_M) {
            // Fix too inaccurate to trust for distance — skip but don't advance
            // prev. The next fix is compared against the last good point.
            return
        }
        val pLat = service.prevLat
        val pLon = service.prevLon
        val pTime = service.prevTimeMs
        if (pLat != null && pLon != null && pTime != null) {
            val dtSec = (pt.timeMs - pTime) / 1000.0
            if (dtSec <= 0.0) {
                // Zero/negative dt (duplicate timestamp or clock skew). Drop
                // without advancing prev — the next fix's dt will be measured
                // from the last good fix.
                SafeLog.d(GpsRecorderService.TAG, "accumulateDistance: dropping zero-dt fix (dt=${dtSec}s)")
                return
            }
            val d = precomputedDistanceM ?: TrackMath.haversineMeters(pLat, pLon, pt.lat, pt.lon)
            // L22 fix: bypass velocity gate for sub-half-second dt — the
            // displacement is too small to produce a reliable velocity.
            if (dtSec >= MIN_VELOCITY_GATE_DT_SEC) {
                val velocityMps = d / dtSec
                // Drop the contribution if the implied velocity exceeds the walk/
                // run ceiling. These are usually GPS glitches after a cold start
                // or tunnel exit; they would otherwise inflate service.totalDistanceM.
                if (velocityMps > MAX_VELOCITY_MPS) {
                    SafeLog.d(GpsRecorderService.TAG, "accumulateDistance: dropping velocity outlier (v=${velocityMps}m/s d=${d}m dt=${dtSec}s)")
                    // Do NOT advance prev — keep the last good fix as the
                    // reference so the next fix's distance is computed from it,
                    // not from this outlier.
                    return
                }
            }
            service.totalDistanceM += d
        }
        // Candidate accepted (or no prev to compare against) — advance cursor.
        service.prevLat = pt.lat
        service.prevLon = pt.lon
        service.prevTimeMs = pt.timeMs
    }

    // ------------------------------------------------------------------
    // Required LocationListener overrides for older Android API levels
    // ------------------------------------------------------------------

    override fun onProviderEnabled(provider: String) {}

    override fun onProviderDisabled(provider: String) {
        Log.w(GpsRecorderService.TAG, "Provider disabled: $provider")
    }

    @Deprecated("legacy")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
}
