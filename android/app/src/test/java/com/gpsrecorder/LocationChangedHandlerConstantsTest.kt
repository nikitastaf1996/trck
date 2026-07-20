package com.gpsrecorder

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue

/**
 * Unit tests for the constants declared in [LocationChangedHandler]'s
 * companion object.
 *
 * These constants drive the 8-stage on-the-fly filter pipeline. A silent
 * change to any of them would subtly alter the track quality. These
 * tests pin each constant so a refactor (or a "let me just tweak this")
 * shows up as a failing test that the developer has to consciously update.
 */
class LocationChangedHandlerConstantsTest {

    @Test
    fun accuracyThresholdM_is25Meters_tightenedFrom50M() {
        assertEquals(25.0f, LocationChangedHandler.ACCURACY_THRESHOLD_M, 0.0001f)
    }

    @Test
    fun maxFixAgeMs_is3Seconds_strictGateForGpsProviderAndFirstFix() {
        assertEquals(3_000L, LocationChangedHandler.MAX_FIX_AGE_MS)
    }

    @Test
    fun maxFixAgeMsRelaxed_is30Seconds_relaxedGateForNetworkFusedProviders() {
        assertEquals(30_000L, LocationChangedHandler.MAX_FIX_AGE_MS_RELAXED)
    }

    @Test
    fun maxVelocityMps_is5Point5556Mps_about20KmPerHourWalkingRunningCeiling() {
        assertEquals(5.5556f, LocationChangedHandler.MAX_VELOCITY_MPS, 0.0001f)
    }

    @Test
    fun minVelocityGateDtSec_is0Point5Seconds_bypassVelocityGateForSubHalfSecondDt() {
        assertEquals(0.5, LocationChangedHandler.MIN_VELOCITY_GATE_DT_SEC, 0.0001)
    }

    // ------------------------------------------------------------------
    // Cross-checks
    // ------------------------------------------------------------------

    @Test
    fun maxFixAgeMsRelaxed_isStrictlyGreaterThanMaxFixAgeMs() {
        assertTrue(
            "MAX_FIX_AGE_MS_RELAXED (${LocationChangedHandler.MAX_FIX_AGE_MS_RELAXED}) must be > " +
                "MAX_FIX_AGE_MS (${LocationChangedHandler.MAX_FIX_AGE_MS})",
            LocationChangedHandler.MAX_FIX_AGE_MS_RELAXED > LocationChangedHandler.MAX_FIX_AGE_MS
        )
    }

    @Test
    fun maxVelocityMps_inKmPerHour_isAbout20KmPerHour() {
        // 5.5556 m/s × 3.6 = 20.00016 km/h.
        val kmh = LocationChangedHandler.MAX_VELOCITY_MPS * 3.6f
        assertEquals(20.0f, kmh, 0.01f)
    }

    @Test
    fun accuracyThresholdM_inMeters_is25MetersPerTheTightenedSetting() {
        // The comment says "tightened from 50 m to 25 m per the user's request".
        // 25 m is permissive enough for cold-start fixes but filters out
        // the worst multipath noise.
        assertTrue(
            "ACCURACY_THRESHOLD_M (${LocationChangedHandler.ACCURACY_THRESHOLD_M}) should be <= 50",
            LocationChangedHandler.ACCURACY_THRESHOLD_M <= 50.0f
        )
        assertTrue(
            "ACCURACY_THRESHOLD_M (${LocationChangedHandler.ACCURACY_THRESHOLD_M}) should be >= 10",
            LocationChangedHandler.ACCURACY_THRESHOLD_M >= 10.0f
        )
    }

    @Test
    fun minVelocityGateDtSec_isLessThan1Second() {
        // The L22 fix comment says dt < 0.5 s bypasses the velocity gate.
        // 0.5 s is chosen so 1.4 m/s walk × 0.5 s = 0.7 m → 1.4 m/s velocity
        // doesn't trigger the 5.55 m/s ceiling.
        assertTrue(
            "MIN_VELOCITY_GATE_DT_SEC (${LocationChangedHandler.MIN_VELOCITY_GATE_DT_SEC}) should be < 1.0",
            LocationChangedHandler.MIN_VELOCITY_GATE_DT_SEC < 1.0
        )
    }
}
