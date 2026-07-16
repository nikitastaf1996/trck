package com.gpsrecorder

import android.location.Location
import android.location.LocationListener
import android.os.Bundle
import android.util.Log

/**
 * LocationChangedHandler
 *
 * K7: extracted from `GpsRecorderService.kt` so the service file stays under
 * 1000 lines. Owns the `onLocationChanged` callback (8 filter stages:
 * stale-fix, gap-detection / recovery, auto-pause enter / exit hysteresis,
 * time-sampling, accuracy, velocity, radial-distance, raw-mode distance
 * accumulator).
 *
 * K10: split further to get this file under 500 lines. The auto-pause phase
 * (Phase 3) moved to [AutoPauseHandler] and the raw-mode `accumulateDistance`
 * helper moved to [DistanceAccumulator]. This file now owns the remaining
 * 7 stages plus the shared emit-on-drop helpers (`emitFix`,
 * `updateNotificationSnapshot`, `emitDroppedFix`).
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
 * [DistanceAccumulator] accesses the four filter constants via
 * `LocationChangedHandler.X` (they're shared between the on-the-fly filter
 * here and the raw-mode accumulator there). Settings reads go through
 * [GpsRecorderSettings] directly (passing the service as the `Context`).
 * Threshold getters (`getRadialDistanceThresholdM`, `getTimeSamplingN`)
 * remain on the service (made `internal` for K7) and are called via
 * `service.X()`.
 *
 * Behavior is byte-for-byte identical to the pre-K7 in-service
 * implementation — every filter stage, every emit-on-drop pattern, every
 * accuracy / velocity / radial / time-sampling gate is preserved verbatim.
 * The K10 extraction (auto-pause → [AutoPauseHandler], distance accumulator
 * → [DistanceAccumulator], 9× emit-on-drop pattern → `emitFix` /
 * `emitDroppedFix` / `updateNotificationSnapshot`) preserves the exact
 * sequence of `service.lastFixTimeMs` / `service.stateRepository.saveLiveState`
 * / `GpsEventEmitter.emitLocation` / `service.notifier.updateNotification`
 * calls at every site. Only the references are rewired to go through
 * `service.` / `GpsRecorderService.` / `GpsRecorderSettings.` /
 * `LocationChangedHandler.`.
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
        //
        // M2 fix (Task 5): this strict 3 s gate is now applied ONLY to fixes
        // from the GPS provider (provider == "gps") AND to the very FIRST fix
        // of a recording (regardless of provider) — those are the cases where
        // a stale cached fix is most likely to corrupt the track. Network /
        // fused providers routinely deliver cached fixes 5–30 s old indoors
        // or in deep urban canyons, and dropping them all leaves the user
        // with no recorded points at all in those environments. For non-GPS
        // providers, we accept fixes up to MAX_FIX_AGE_MS_RELAXED (30 s).
        internal const val MAX_FIX_AGE_MS = 3000L
        // Relaxed age gate for network / fused providers. 30 s matches the
        // typical Android location cache TTL and is short enough that a
        // truly stale fix (e.g. an hour-old getLastKnownLocation seed) is
        // still rejected.
        internal const val MAX_FIX_AGE_MS_RELAXED = 30_000L

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

    // K10: extracted to DistanceAccumulator / AutoPauseHandler so this file
    // stays under 500 lines.
    private val distanceAccumulator = DistanceAccumulator(service)
    private val autoPauseHandler = AutoPauseHandler(service)

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
        //
        // M2 fix (Task 5): the strict 3 s gate (MAX_FIX_AGE_MS) is now applied
        // ONLY to fixes from the GPS provider AND to the very FIRST fix of a
        // recording. Network / fused providers routinely deliver cached fixes
        // 5–30 s old indoors or in deep urban canyons; applying the strict
        // gate to them dropped legitimate fixes and left the user with no
        // recorded points at all in those environments.
        //
        // The FIRST fix of a recording is always gated strictly regardless
        // of provider — that's the case where a stale cached fix would most
        // corrupt the track (it would seed prevLat/prevLon/lastFixTimeMs and
        // inflate the distance of the next fresh fix). After the first fix,
        // the velocity gate (below) catches any "impossible jump" from a
        // stale fix, so the relaxed age gate is sufficient.
        val fixAgeMs = System.currentTimeMillis() - pt.timeMs
        val isFirstFix = service.lastFixTimeMs <= 0L
        val isGpsProvider = location.provider == "gps"
        val ageLimit = if (isFirstFix || isGpsProvider) MAX_FIX_AGE_MS else MAX_FIX_AGE_MS_RELAXED
        if (fixAgeMs > ageLimit) {
            // L33 fix: downgrade to SafeLog.d and strip lat/lon — this was
            // the only Log.w call in the service that leaked GPS coordinates
            // in release builds.
            SafeLog.d(GpsRecorderService.TAG, "Dropping stale fix: age=${fixAgeMs}ms provider=${location.provider} limit=${ageLimit}ms")
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
            updateNotificationSnapshot()
            Log.i(GpsRecorderService.TAG, "Gap detection disabled or auto-paused — clearing service.signalLost flag")
        }

        // ---- Phase 3: Auto-pause (stop detection) ----
        // K10: delegated to AutoPauseHandler. Returns true if the fix was
        // dropped (stationary / confirmation-in-progress / confirmation-reset
        // branches); false to continue with the time-sampling / accuracy /
        // velocity / radial gates (auto-pause disabled, user moving while not
        // paused, or resume just confirmed).
        if (autoPauseHandler.handle(pt)) return

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
                emitDroppedFix(pt)
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
                emitDroppedFix(pt)
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
                    emitDroppedFix(pt)
                    return
                }
                val d = TrackMath.haversineMeters(pLat, pLon, pt.lat, pt.lon)
                if (dtSec >= MIN_VELOCITY_GATE_DT_SEC) {
                    val velocityMps = d / dtSec
                    if (velocityMps > MAX_VELOCITY_MPS) {
                        SafeLog.d(GpsRecorderService.TAG, "On-the-fly filter: dropping velocity outlier (v=${velocityMps}m/s d=${d}m dt=${dtSec}s)")
                        emitDroppedFix(pt)
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
                        emitDroppedFix(pt)
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
                        emitDroppedFix(pt)
                        return
                    }
                }
            }
            // E. Fallback: record every fix raw so the GPX file keeps the noisy
            // data, but still keep the displayed distance sane by routing the
            // accuracy/velocity gates through the distance accumulator only.
            service.pointCount = service.segmentedBuffer.appendPointToCurrentSegment(pt)
            distanceAccumulator.accumulateDistance(pt, precomputedD)
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

    // K10: shared helpers for the emit-on-drop pattern. `emitFix` does the
    // saveLiveState + emitLocation sequence that every drop site in this
    // file (and in AutoPauseHandler) performs; `updateNotificationSnapshot`
    // wraps the NotificationSnapshot builder; `emitDroppedFix` chains the
    // two for the 6 on-the-fly-filter drop sites that DO update the
    // notification (the auto-pause branches in AutoPauseHandler
    // intentionally skip the notifier call — paused fixes don't toggle the
    // notification — so they call their own emitFix copy directly).
    private fun emitFix(pt: GpsPoint) {
        service.lastFixTimeMs = pt.timeMs
        service.stateRepository.saveLiveState(pt)
        GpsEventEmitter.emitLocation(
            pt.lat, pt.lon, pt.alt, pt.speed, pt.accuracy,
            service.locationSource.computeFixType(service.lastFixTimeMs), service.totalDistanceM, pt.timeMs, service.pointCount,
            service.isAutoPaused, service.signalLost, service.autoPauseGap.liveMovingMs(pt.timeMs)
        )
    }

    private fun updateNotificationSnapshot() {
        service.notifier.updateNotification(
            GpsRecorderNotification.NotificationSnapshot(
                points = service.pointCount,
                elapsedMs = service.getElapsedMs(),
                isAutoPaused = service.isAutoPaused,
                signalLost = service.signalLost
            )
        )
    }

    private fun emitDroppedFix(pt: GpsPoint) {
        emitFix(pt)
        updateNotificationSnapshot()
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
