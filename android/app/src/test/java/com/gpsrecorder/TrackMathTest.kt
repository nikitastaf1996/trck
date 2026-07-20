package com.gpsrecorder

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import kotlin.math.abs

/**
 * Unit tests for [TrackMath] — the pure-JVM geodesy helper.
 *
 * These run on a stock JDK with no Android framework required because
 * [TrackMath] only uses `java.lang.Math` + `kotlin.Double`. They cover:
 *
 *   - haversineMeters: known distances (e.g. Moscow → St Petersburg ≈ 635 km).
 *   - haversineMeters: zero distance for identical points.
 *   - haversineMeters: symmetry — distance(A, B) === distance(B, A).
 *   - bearingRad: due-east bearing is 0 (due north is +π/2).
 *   - crossTrackDistanceM: zero when P lies on the a→b segment.
 *   - crossTrackDistanceM: zero for the degenerate-segment case (a == b).
 *   - crossTrackDistanceM: roughly equals the perpendicular distance for
 *     short segments near the equator (where Euclidean ≈ spherical).
 */
class TrackMathTest {

    // ~1 m tolerance for haversine — at 6 371 000 m Earth radius, the
    // precision of Double is more than enough; the tolerance absorbs
    // differences in WGS-84 vs mean-radius approximations.
    private val haversineToleranceM = 1.0

    // ~0.001 m tolerance for cross-track distance — the algorithm uses
    // an `asin` clamp at ±1.0 so values are exact at the boundaries.
    private val crossTrackToleranceM = 0.001

    @Test
    fun haversine_returnsZero_forIdenticalPoints() {
        assertEquals(0.0, TrackMath.haversineMeters(55.0, 37.0, 55.0, 37.0), haversineToleranceM)
    }

    @Test
    fun haversine_returnsZero_forBothAtZeroZero() {
        // Origin — degenerate but should not crash.
        assertEquals(0.0, TrackMath.haversineMeters(0.0, 0.0, 0.0, 0.0), haversineToleranceM)
    }

    @Test
    fun haversine_returns1DegreeOfLatitude_for10DegreeLatDifference() {
        // 1 degree of latitude ≈ 111.195 km (mean-Earth approximation).
        // We compute the distance between (0, 0) and (1, 0) — both on the
        // prime meridian, so the displacement is purely latitudinal.
        val d = TrackMath.haversineMeters(0.0, 0.0, 1.0, 0.0)
        assertEquals(111_195.0, d, 100.0) // ±100 m tolerance
    }

    @Test
    fun haversine_returns1DegreeOfLongitudeAtEquator_for10DegreeLonDifference() {
        // At the equator, 1 degree of longitude ≈ 111.195 km.
        val d = TrackMath.haversineMeters(0.0, 0.0, 0.0, 1.0)
        assertEquals(111_195.0, d, 100.0)
    }

    @Test
    fun haversine_returnsSmallerLongitudeDistance_atHigherLatitudes() {
        // At 60° latitude, 1 degree of longitude ≈ 111.195 * cos(60°) = 55.6 km.
        val d = TrackMath.haversineMeters(60.0, 0.0, 60.0, 1.0)
        assertEquals(55_597.0, d, 100.0)
    }

    @Test
    fun haversine_returnsExpectedDistance_forMoscowToStPetersburg() {
        // Moscow: 55.7558°N, 37.6173°E
        // St Petersburg: 59.9343°N, 30.3351°E
        // Great-circle distance is ≈ 634 km.
        val d = TrackMath.haversineMeters(55.7558, 37.6173, 59.9343, 30.3351)
        assertEquals(634_000.0, d, 2_000.0) // ±2 km tolerance (rounding)
    }

    @Test
    fun haversine_isSymmetric_distanceAB_equals_distanceBA() {
        val a = doubleArrayOf(55.0, 37.0)
        val b = doubleArrayOf(60.0, 30.0)
        val dAB = TrackMath.haversineMeters(a[0], a[1], b[0], b[1])
        val dBA = TrackMath.haversineMeters(b[0], b[1], a[0], a[1])
        assertEquals(dAB, dBA, 0.001)
    }

    @Test
    fun haversine_satisfiesTriangleInequality() {
        // |AB| + |BC| ≥ |AC| for any three points.
        val a = doubleArrayOf(55.0, 37.0)
        val b = doubleArrayOf(56.0, 38.0)
        val c = doubleArrayOf(60.0, 30.0)
        val ab = TrackMath.haversineMeters(a[0], a[1], b[0], b[1])
        val bc = TrackMath.haversineMeters(b[0], b[1], c[0], c[1])
        val ac = TrackMath.haversineMeters(a[0], a[1], c[0], c[1])
        assertTrue("AB + BC should be >= AC", ab + bc >= ac - 0.001)
    }

    // ------------------------------------------------------------------
    // bearingRad
    // ------------------------------------------------------------------

    @Test
    fun bearing_fromEquatorPointToDueEast_isZero() {
        // From (0, 0) to (0, 1) — due east. The bearingRad helper returns
        // 0 for due east (because atan2(0, 1) = 0 in the (y, x) convention
        // used by TrackMath).
        val b = TrackMath.bearingRad(0.0, 0.0, 0.0, 1.0)
        assertEquals(0.0, b, 0.0001)
    }

    @Test
    fun bearing_fromEquatorPointToDueNorth_isHalfPi() {
        // From (0, 0) to (1, 0) — due north. Bearing = π/2.
        val b = TrackMath.bearingRad(0.0, 0.0, 1.0, 0.0)
        assertEquals(Math.PI / 2, b, 0.0001)
    }

    @Test
    fun bearing_fromEquatorPointToDueWest_isPlusOrMinusPi() {
        // From (0, 0) to (0, -1) — due west. Bearing = ±π (atan2 returns
        // π for negative x).
        val b = TrackMath.bearingRad(0.0, 0.0, 0.0, -1.0)
        assertTrue("bearing should be near π or -π, was $b", abs(abs(b) - Math.PI) < 0.0001)
    }

    @Test
    fun bearing_fromEquatorPointToDueSouth_isMinusHalfPi() {
        // From (0, 0) to (-1, 0) — due south. Bearing = -π/2.
        val b = TrackMath.bearingRad(0.0, 0.0, -1.0, 0.0)
        assertEquals(-Math.PI / 2, b, 0.0001)
    }

    @Test
    fun bearing_fromPointToItself_isAnyFiniteValue() {
        // Degenerate case — both points coincide. The bearing is undefined
        // (atan2(0, 0) = 0 in IEEE), but the helper should not crash.
        val b = TrackMath.bearingRad(55.0, 37.0, 55.0, 37.0)
        assertTrue("bearing should be finite, was $b", !b.isNaN() && !b.isInfinite())
    }

    // ------------------------------------------------------------------
    // crossTrackDistanceM
    // ------------------------------------------------------------------

    @Test
    fun crossTrack_returnsZero_whenPointIsOnSegment() {
        // Point P is the midpoint of segment a→b → cross-track = 0.
        val aLat = 0.0
        val aLon = 0.0
        val bLat = 0.0
        val bLon = 0.01 // small eastward displacement
        val pLat = 0.0
        val pLon = 0.005 // midway between a and b
        val d = TrackMath.crossTrackDistanceM(pLat, pLon, aLat, aLon, bLat, bLon)
        assertEquals(0.0, d, crossTrackToleranceM)
    }

    @Test
    fun crossTrack_returnsZero_whenPointIsAtSegmentEndpoint() {
        // P coincides with the segment's endpoint a → cross-track = 0.
        val d = TrackMath.crossTrackDistanceM(0.0, 0.0, 0.0, 0.0, 0.0, 1.0)
        assertEquals(0.0, d, crossTrackToleranceM)
    }

    @Test
    fun crossTrack_returnsZero_whenSegmentIsDegenerate_aAndBCoincide() {
        // L12 fix: when a and b coincide, the function returns 0 (so
        // Douglas-Peucker drops all intermediate points in such a segment).
        val d = TrackMath.crossTrackDistanceM(55.0, 37.0, 60.0, 30.0, 60.0, 30.0)
        assertEquals(0.0, d, crossTrackToleranceM)
    }

    @Test
    fun crossTrack_returnsNonZero_whenPointIsOffSegment() {
        // Point is 1° north of segment a(0,0)→b(0,1) (which is on the equator).
        // 1° latitude ≈ 111 km, so cross-track should be ~111 km.
        val d = TrackMath.crossTrackDistanceM(1.0, 0.5, 0.0, 0.0, 0.0, 1.0)
        assertEquals(111_195.0, d, 1_000.0) // ±1 km
    }

    @Test
    fun crossTrack_returnsAbsoluteValue_alwaysNonNegative() {
        // The helper returns Math.abs(dXt) — verify it's non-negative for
        // points both north and south of the segment.
        val dNorth = TrackMath.crossTrackDistanceM(1.0, 0.5, 0.0, 0.0, 0.0, 1.0)
        val dSouth = TrackMath.crossTrackDistanceM(-1.0, 0.5, 0.0, 0.0, 0.0, 1.0)
        assertTrue("cross-track north should be non-negative, was $dNorth", dNorth >= 0.0)
        assertTrue("cross-track south should be non-negative, was $dSouth", dSouth >= 0.0)
        // And the magnitudes should be equal (symmetric).
        assertEquals(dNorth, dSouth, 0.001)
    }

    @Test
    fun crossTrack_handlesLargeDistancesWithoutNaN() {
        // Long segment + far point — verify the asin clamp prevents NaN.
        val d = TrackMath.crossTrackDistanceM(89.0, 0.0, 0.0, 0.0, 0.0, 1.0)
        assertFalse("cross-track should not be NaN, was $d", d.isNaN())
        assertFalse("cross-track should not be Infinite, was $d", d.isInfinite())
    }
}
