package com.gpsrecorder

/**
 * DistanceAccumulator
 *
 * K10: extracted from [LocationChangedHandler] so that file stays under 500
 * lines. Owns the `accumulateDistance` helper that the raw-mode (no
 * on-the-fly filter) branch of `onLocationChanged` calls after appending
 * every fix to the buffer.
 *
 * The accumulator holds no GPS / recording state of its own — all such
 * state (`prevLat`, `prevLon`, `prevTimeMs`, `totalDistanceM`) remains on
 * [GpsRecorderService] as `@Volatile internal var`s; the accumulator reads
 * / writes them via `service.` references so the existing threading model
 * is preserved unchanged.
 *
 * Filter constants (`ACCURACY_THRESHOLD_M`, `MAX_VELOCITY_MPS`,
 * `MIN_VELOCITY_GATE_DT_SEC`) stay on [LocationChangedHandler]'s companion
 * object (they are shared with the on-the-fly filter in `onLocationChanged`);
 * this class accesses them via `LocationChangedHandler.X`.
 *
 * Behavior is byte-for-byte identical to the pre-K10 in-handler
 * implementation — every accuracy / velocity gate, every drop / accept
 * decision is preserved verbatim. Only the references are rewired to go
 * through `service.` / `LocationChangedHandler.`.
 */
class DistanceAccumulator internal constructor(
    private val service: GpsRecorderService,
) {

    internal fun accumulateDistance(pt: GpsPoint, precomputedDistanceM: Double? = null) {
        val acc = pt.accuracy
        if (acc != null && acc > LocationChangedHandler.ACCURACY_THRESHOLD_M) {
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
            if (dtSec >= LocationChangedHandler.MIN_VELOCITY_GATE_DT_SEC) {
                val velocityMps = d / dtSec
                // Drop the contribution if the implied velocity exceeds the walk/
                // run ceiling. These are usually GPS glitches after a cold start
                // or tunnel exit; they would otherwise inflate service.totalDistanceM.
                if (velocityMps > LocationChangedHandler.MAX_VELOCITY_MPS) {
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
}
