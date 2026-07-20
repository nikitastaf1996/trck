package com.gpsrecorder

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue

/**
 * Unit tests for the constants and thresholds declared in
 * [AutoPauseGapController]'s companion object.
 *
 * These constants drive the auto-pause / gap-detection state machine
 * (raw window size, speed threshold, displacement threshold, hysteresis
 * thresholds, gap threshold, grace window, persistence keys). They're
 * used by:
 *
 *   - AutoPauseGapController (the state machine itself)
 *   - AutoPauseHandler (the per-fix logic)
 *   - LocationChangedHandler (the per-fix logic that delegates to auto-pause)
 *   - StateRepository (recovery on START_STICKY restart)
 *
 * A silent change to any of these constants would change the auto-pause
 * behaviour in subtle ways. These tests pin each constant so a future
 * refactor (or a "let me just tweak this") shows up as a failing test
 * that the developer has to consciously update.
 *
 * The values are also documented in the AGENTS.md and CHANGELOG.md
 * files; if you change them here, update those docs too.
 */
class AutoPauseGapControllerConstantsTest {

    @Test
    fun rawWindowMs_is10Seconds() {
        assertEquals(10_000L, AutoPauseGapController.RAW_WINDOW_MS)
    }

    @Test
    fun speedThresholdMps_is0Point35Mps_about1Point26KmPerHour() {
        assertEquals(0.35f, AutoPauseGapController.SPEED_THRESHOLD_MPS, 0.0001f)
    }

    @Test
    fun displacementThresholdM_is3Point5Meters_aboutGpsNoiseDiameter() {
        assertEquals(3.5, AutoPauseGapController.DISPLACEMENT_THRESHOLD_M, 0.0001)
    }

    @Test
    fun movingConfirmationThreshold_is3ConsecutiveFixes() {
        assertEquals(3, AutoPauseGapController.MOVING_CONFIRMATION_THRESHOLD)
    }

    @Test
    fun hysteresisSpeedMs_is0Point5Mps_slowWalk() {
        assertEquals(0.5f, AutoPauseGapController.HYSTERESIS_SPEED_MS, 0.0001f)
    }

    @Test
    fun hysteresisDisplacementMps_is1Point5Mps_fallbackWhenSpeedIsNull() {
        assertEquals(1.5, AutoPauseGapController.HYSTERESIS_DISPLACEMENT_MPS, 0.0001)
    }

    @Test
    fun gapThresholdMs_is15Seconds() {
        assertEquals(15_000L, AutoPauseGapController.GAP_THRESHOLD_MS)
    }

    @Test
    fun rawWindowSize_is10Entries_at1HzCovers10Seconds() {
        assertEquals(10, AutoPauseGapController.RAW_WINDOW_SIZE)
    }

    @Test
    fun resumeGracePersistenceKey_isSnakeCaseCamelCase() {
        assertEquals("auto_pause_resume_grace_until_ms", AutoPauseGapController.KEY_RESUME_GRACE_UNTIL_MS)
    }

    @Test
    fun consecutiveMovingFixesPersistenceKey_isSnakeCase() {
        assertEquals("consecutive_moving_fixes", AutoPauseGapController.KEY_CONSECUTIVE_MOVING_FIXES)
    }

    // ------------------------------------------------------------------
    // Cross-checks: are the constants internally consistent?
    // ------------------------------------------------------------------

    @Test
    fun hysteresisSpeedMs_isStrictlyGreaterThanSpeedThresholdMps() {
        // If hysteresis were BELOW the speed threshold, the user would
        // have to slow DOWN to resume — that's backwards.
        assertTrue(
            "HYSTERESIS_SPEED_MS (${AutoPauseGapController.HYSTERESIS_SPEED_MS}) must be > " +
                "SPEED_THRESHOLD_MPS (${AutoPauseGapController.SPEED_THRESHOLD_MPS})",
            AutoPauseGapController.HYSTERESIS_SPEED_MS > AutoPauseGapController.SPEED_THRESHOLD_MPS
        )
    }

    @Test
    fun rawWindowSize_isAtLeastMovingConfirmationThreshold() {
        // The moving-confirmation window needs ≥ MOVING_CONFIRMATION_THRESHOLD
        // fixes inside the RAW_WINDOW_MS of history. If RAW_WINDOW_SIZE
        // were smaller than the threshold, we could never accumulate
        // enough confirmation fixes.
        assertTrue(
            "RAW_WINDOW_SIZE (${AutoPauseGapController.RAW_WINDOW_SIZE}) must be >= " +
                "MOVING_CONFIRMATION_THRESHOLD (${AutoPauseGapController.MOVING_CONFIRMATION_THRESHOLD})",
            AutoPauseGapController.RAW_WINDOW_SIZE >= AutoPauseGapController.MOVING_CONFIRMATION_THRESHOLD
        )
    }

    @Test
    fun gapThresholdMs_isStrictlyGreaterThanRawWindowMs() {
        // The gap threshold (15s) must exceed the raw window (10s),
        // otherwise the gap watchdog would fire before the raw window
        // could have collected enough stationary fixes to engage auto-pause.
        assertTrue(
            "GAP_THRESHOLD_MS (${AutoPauseGapController.GAP_THRESHOLD_MS}) must be > " +
                "RAW_WINDOW_MS (${AutoPauseGapController.RAW_WINDOW_MS})",
            AutoPauseGapController.GAP_THRESHOLD_MS > AutoPauseGapController.RAW_WINDOW_MS
        )
    }
}
