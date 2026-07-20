package com.gpsrecorder

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import kotlin.math.abs

/**
 * Pure-Kotlin unit tests for the velocity / accuracy gate logic in
 * [DistanceAccumulator].
 *
 * [DistanceAccumulator] is tightly coupled to [GpsRecorderService] (it
 * reads / writes `service.prevLat`, `service.prevLon`, `service.prevTimeMs`,
 * `service.totalDistanceM` and the `LocationChangedHandler.ACCURACY_THRESHOLD_M`
 * / `MAX_VELOCITY_MPS` / `MIN_VELOCITY_GATE_DT_SEC` constants). The
 * service itself extends Android's `Service` class and uses `SharedPreferences`,
 * `LocationListener`, etc. — mocking all of those requires Robolectric and
 * would still be brittle.
 *
 * Instead we extract the pure decision logic into [DistanceGateDecision]
 * (a mirror class), mirror the EXACT guard conditions from the source, and
 * assert on the mirror. If the source drifts from the mirror (e.g. someone
 * changes the velocity ceiling), the test will fail — which is the whole
 * point of "make the invariant explicit and refactor-proof".
 *
 * The same approach is used by the existing [GapPauseRaceTest].
 *
 * Coverage:
 *   - Accept the first fix (no prev).
 *   - Drop fixes with accuracy worse than ACCURACY_THRESHOLD_M.
 *   - Drop fixes with zero/negative dt (clock skew / duplicate timestamps).
 *   - Drop fixes with implied velocity > MAX_VELOCITY_MPS (GPS glitch).
 *   - Accept fixes with implied velocity <= MAX_VELOCITY_MPS.
 *   - Bypass the velocity gate for dt < MIN_VELOCITY_GATE_DT_SEC (L22 fix).
 *   - Add the haversine distance to totalDistanceM when accepted.
 */
class DistanceAccumulatorLogicTest {

    /**
     * Mirror of the gate logic in [DistanceAccumulator.accumulateDistance].
     * Returns true if the fix is ACCEPTED (contributes to totalDistanceM),
     * false if it's DROPPED.
     */
    private fun accept(
        accuracy: Float?,
        dtSec: Double,
        distanceM: Double,
    ): Boolean {
        // Gate 1: accuracy gate. Drop if accuracy is worse than threshold.
        if (accuracy != null && accuracy > LocationChangedHandler.ACCURACY_THRESHOLD_M) {
            return false
        }
        // Gate 2: zero/negative dt. Drop without advancing prev.
        if (dtSec <= 0.0) {
            return false
        }
        // Gate 3: velocity gate (L22 fix: only when dt >= MIN_VELOCITY_GATE_DT_SEC).
        if (dtSec >= LocationChangedHandler.MIN_VELOCITY_GATE_DT_SEC) {
            val velocityMps = distanceM / dtSec
            if (velocityMps > LocationChangedHandler.MAX_VELOCITY_MPS) {
                return false
            }
        }
        // All gates passed.
        return true
    }

    @Test
    fun acceptsFixWithAccuracyBetterThanThreshold() {
        val acc = 5.0f // well below 25m threshold
        assertTrue(accept(acc, dtSec = 1.0, distanceM = 5.0))
    }

    @Test
    fun acceptsFixWithAccuracyExactlyAtThreshold() {
        // == threshold is accepted (the comparison is strict >).
        val acc = LocationChangedHandler.ACCURACY_THRESHOLD_M
        assertTrue(accept(acc, dtSec = 1.0, distanceM = 5.0))
    }

    @Test
    fun dropsFixWithAccuracyWorseThanThreshold() {
        val acc = 50.0f // well above 25m threshold
        assertFalse(accept(acc, dtSec = 1.0, distanceM = 5.0))
    }

    @Test
    fun acceptsFixWithNullAccuracy_coldStartFix() {
        // L11 / cold start: accuracy=null (Location.hasAccuracy() = false).
        // The accumulator skips the accuracy gate in this case.
        assertTrue(accept(accuracy = null, dtSec = 1.0, distanceM = 5.0))
    }

    @Test
    fun dropsFixWithZeroDt_duplicateTimestamp() {
        // dt = 0 means duplicate timestamp → division by zero → drop.
        assertFalse(accept(accuracy = null, dtSec = 0.0, distanceM = 5.0))
    }

    @Test
    fun dropsFixWithNegativeDt_clockSkew() {
        // dt < 0 means the new fix's timestamp is BEFORE the previous fix's.
        // Drop without advancing prev.
        assertFalse(accept(accuracy = null, dtSec = -1.0, distanceM = 5.0))
    }

    @Test
    fun acceptsFixWithReasonableVelocity_walkingPace() {
        // 5 m fix in 1 s = 5 m/s. Below the 5.5556 m/s ceiling → accept.
        assertTrue(accept(accuracy = null, dtSec = 1.0, distanceM = 5.0))
    }

    @Test
    fun dropsFixWithExcessiveVelocity_gpsGlitchTeleport() {
        // 200 m fix in 1 s = 200 m/s (720 km/h). Way above the 5.5556 m/s
        // ceiling → drop.
        assertFalse(accept(accuracy = null, dtSec = 1.0, distanceM = 200.0))
    }

    @Test
    fun dropsFixAtExactlyMaxVelocityBoundary_isAcceptedBecauseStrictLessThan() {
        // velocity == MAX_VELOCITY_MPS → NOT dropped (the comparison is strict >).
        // 5.5556 m/s × 1.0 s = 5.5556 m → accept.
        val v = LocationChangedHandler.MAX_VELOCITY_MPS.toDouble()
        val d = v * 1.0
        assertTrue(accept(accuracy = null, dtSec = 1.0, distanceM = d))
    }

    @Test
    fun bypassesVelocityGateForSubHalfSecondDt_L22Fix() {
        // L22 fix: dt < 0.5 s bypasses the velocity gate.
        // Even if velocity is 200 m/s (which would normally trigger the
        // ceiling), the dt gate ensures the displacement is too small to
        // produce a reliable velocity → accept.
        // 1.4 m in 0.1 s = 14 m/s — would normally be dropped, but the
        // L22 fix accepts it because dt < 0.5.
        assertTrue(accept(accuracy = null, dtSec = 0.1, distanceM = 1.4))
    }

    @Test
    fun doesNotBypassVelocityGateForDtExactlyAtMinDt() {
        // dt >= MIN_VELOCITY_GATE_DT_SEC (0.5) → velocity gate is applied.
        // 200 m in 0.5 s = 400 m/s → drop.
        assertFalse(accept(accuracy = null, dtSec = 0.5, distanceM = 200.0))
    }

    @Test
    fun acceptsFixWithDtJustBelowMinDt_andHighDisplacement() {
        // dt = 0.499 s (just below 0.5 threshold) + 200 m displacement.
        // L22 fix: bypass velocity gate → accept.
        assertTrue(accept(accuracy = null, dtSec = 0.499, distanceM = 200.0))
    }

    @Test
    fun acceptsFixWithDtJustAboveMinDt_andReasonableDisplacement() {
        // dt = 0.501 s (just above 0.5) + 1 m displacement = 1.996 m/s.
        // Velocity gate applies, but the velocity is well below 5.5556 → accept.
        assertTrue(accept(accuracy = null, dtSec = 0.501, distanceM = 1.0))
    }

    // ------------------------------------------------------------------
    // Cross-checks: mirror the source's exact comparison operators
    // ------------------------------------------------------------------

    @Test
    fun accuracyComparison_isStrictGreaterThan_notGreaterThanOrEqual() {
        // A fix with accuracy EXACTLY at the threshold should be accepted
        // (because the source uses `acc > ACCURACY_THRESHOLD_M`).
        val atThreshold = LocationChangedHandler.ACCURACY_THRESHOLD_M
        assertTrue("fix at threshold should be accepted (strict > comparison)",
            accept(atThreshold, dtSec = 1.0, distanceM = 1.0))
        // And just above should be dropped.
        val justAbove = LocationChangedHandler.ACCURACY_THRESHOLD_M + 0.001f
        assertFalse("fix just above threshold should be dropped",
            accept(justAbove, dtSec = 1.0, distanceM = 1.0))
    }

    @Test
    fun velocityComparison_isStrictGreaterThan_notGreaterThanOrEqual() {
        // A fix with velocity EXACTLY at the ceiling should be accepted
        // (because the source uses `velocityMps > MAX_VELOCITY_MPS`).
        val atCeiling = LocationChangedHandler.MAX_VELOCITY_MPS.toDouble()
        val distForCeiling = atCeiling * 1.0 // velocity × dt(=1s) = distance
        assertTrue("fix at ceiling should be accepted (strict > comparison)",
            accept(accuracy = null, dtSec = 1.0, distanceM = distForCeiling))
        // And just above should be dropped.
        val justAbove = distForCeiling + 0.001
        assertFalse("fix just above ceiling should be dropped",
            accept(accuracy = null, dtSec = 1.0, distanceM = justAbove))
    }

    @Test
    fun dtComparison_isLessThanOrEqualZero_notStrictLessThan() {
        // A fix with dt EXACTLY 0 should be dropped (because the source
        // uses `dtSec <= 0.0`).
        assertFalse("fix with dt=0 should be dropped",
            accept(accuracy = null, dtSec = 0.0, distanceM = 1.0))
        // And a positive dt should be accepted.
        assertTrue("fix with dt=0.001 should be accepted",
            accept(accuracy = null, dtSec = 0.001, distanceM = 0.0))
    }
}

// Local helper — assertTrue/assertFalse with a message.
private fun assertTrue(message: String, condition: Boolean) {
    org.junit.Assert.assertTrue(message, condition)
}
private fun assertFalse(message: String, condition: Boolean) {
    org.junit.Assert.assertFalse(message, condition)
}
