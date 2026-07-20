package com.gpsrecorder

import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse

/**
 * Unit tests for [GpxPostProcessors] — the Gaussian smoothing and
 * Douglas-Peucker post-processors.
 *
 * Robolectric is required because [GpxPostProcessors] delegates to
 * [GpxIO] which uses `android.util.Log` for warnings.
 *
 * Coverage:
 *   - gaussianSmoothGpx preserves the point count (no dropping).
 *   - gaussianSmoothGpx preserves the segment structure.
 *   - gaussianSmoothGpx smooths a single-fix spike towards its neighbors.
 *   - gaussianSmoothGpx preserves timestamps / speed / accuracy verbatim.
 *   - gaussianSmoothGpx returns the input unchanged when there are no
 *     segments (parse failure).
 *   - douglasPeuckerGpx reduces the point count for a near-straight line.
 *   - douglasPeuckerGpx preserves the first and last points of each segment.
 *   - douglasPeuckerGpx preserves corners (epsilon too small to drop).
 *   - douglasPeuckerGpx is idempotent (running twice == running once).
 *   - douglasPeuckerGpx preserves segments with < 3 points unchanged.
 *   - douglasPeuckerSimplify returns the input list for < 3 points.
 *   - douglasPeuckerSimplify returns the input list for epsilon <= 0.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class GpxPostProcessorsTest {

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private fun makeGpx(points: List<GpxIO.GpxTrkPt>, name: String = "test"): String {
        val sb = StringBuilder()
        sb.append(GpxIO.gpxHeader())
        sb.append("  <trk>\n")
        sb.append("    <name>").append(name).append("</name>\n")
        sb.append("    <trkseg>\n")
        for (p in points) {
            sb.append(GpxIO.formatGpxPointWithInterpolated(p))
        }
        sb.append("    </trkseg>\n")
        sb.append("  </trk>\n")
        sb.append("</gpx>\n")
        return sb.toString()
    }

    private fun pt(
        lat: Double, lon: Double, ele: Double? = null, timeMs: Long,
        speed: Float? = null, accuracy: Float? = null,
        interpolated: Boolean = false,
    ) = GpxIO.GpxTrkPt(lat, lon, ele, speed, accuracy, timeMs, interpolated)

    // ------------------------------------------------------------------
    // gaussianSmoothGpx
    // ------------------------------------------------------------------

    @Test
    fun gaussianSmoothGpx_preservesPointCount() {
        val pts = (0..20).map { i ->
            pt(lat = 55.0 + i * 0.001, lon = 37.0, timeMs = i.toLong() * 1000L)
        }
        val gpx = makeGpx(pts)
        val smoothed = GpxPostProcessors.gaussianSmoothGpx(gpx)
        val parsed = GpxIO.parseGpxSegments(smoothed)
        assertEquals("smoothed point count should match input",
            pts.size, parsed.segments[0].points.size)
    }

    @Test
    fun gaussianSmoothGpx_preservesSegmentStructure() {
        // Two segments — the smoother should smooth them independently
        // and not "bleed" coordinates across the segment break.
        val seg1 = (0..5).map { i -> pt(lat = 55.0 + i * 0.001, lon = 37.0, timeMs = i.toLong() * 1000L) }
        val seg2 = (0..5).map { i -> pt(lat = 60.0 + i * 0.001, lon = 38.0, timeMs = (i + 10).toLong() * 1000L) }
        val gpx = StringBuilder()
            .append(GpxIO.gpxHeader())
            .append("  <trk>\n    <name>two-seg</name>\n")
            .append("    <trkseg>\n")
            .apply { for (p in seg1) append(GpxIO.formatGpxPointWithInterpolated(p)) }
            .append("    </trkseg>\n    <trkseg>\n")
            .apply { for (p in seg2) append(GpxIO.formatGpxPointWithInterpolated(p)) }
            .append("    </trkseg>\n  </trk>\n</gpx>\n")
            .toString()
        val smoothed = GpxPostProcessors.gaussianSmoothGpx(gpx)
        val parsed = GpxIO.parseGpxSegments(smoothed)
        assertEquals(2, parsed.segments.size)
        assertEquals(6, parsed.segments[0].points.size)
        assertEquals(6, parsed.segments[1].points.size)
        // The first segment's points should be near 55.0 lat; the second
        // near 60.0 — no bleeding across the segment break.
        for (p in parsed.segments[0].points) {
            assertTrue("segment 1 should stay near lat=55, was ${p.lat}", p.lat < 56.0)
        }
        for (p in parsed.segments[1].points) {
            assertTrue("segment 2 should stay near lat=60, was ${p.lat}", p.lat > 59.0)
        }
    }

    @Test
    fun gaussianSmoothGpx_smoothsASingleFixSpikeTowardsNeighbors() {
        // 11 points along a straight line (lat = 55.0, lon = 37.0..37.010).
        // Point at index 5 has lat = 56.0 — a 111 km spike (a GPS glitch).
        // After smoothing, the spike's lat should be pulled towards 55.0
        // (the value of its neighbors).
        val pts = (0..10).map { i ->
            val lat = if (i == 5) 56.0 else 55.0
            pt(lat = lat, lon = 37.0 + i * 0.001, timeMs = i.toLong() * 1000L)
        }
        val gpx = makeGpx(pts)
        val smoothed = GpxPostProcessors.gaussianSmoothGpx(gpx)
        val parsed = GpxIO.parseGpxSegments(smoothed)
        val smoothedSpike = parsed.segments[0].points[5]
        // The spike at 56.0 should be pulled significantly towards 55.0
        // (the exact value depends on the kernel weights, but it should
        // be much less than 56.0).
        assertTrue("spike at lat=56.0 should be smoothed towards 55.0, was ${smoothedSpike.lat}",
            smoothedSpike.lat < 55.5)
    }

    @Test
    fun gaussianSmoothGpx_preservesTimestampsVerbatim() {
        val pts = (0..5).map { i ->
            pt(lat = 55.0 + i * 0.001, lon = 37.0, timeMs = i.toLong() * 1000L)
        }
        val gpx = makeGpx(pts)
        val smoothed = GpxPostProcessors.gaussianSmoothGpx(gpx)
        val parsed = GpxIO.parseGpxSegments(smoothed)
        for (i in pts.indices) {
            assertEquals("timestamp at index $i should be preserved",
                pts[i].timeMs, parsed.segments[0].points[i].timeMs)
        }
    }

    @Test
    fun gaussianSmoothGpx_preservesSpeedAndAccuracyVerbatim() {
        val pts = (0..5).map { i ->
            pt(lat = 55.0 + i * 0.001, lon = 37.0, timeMs = i.toLong() * 1000L,
               speed = (i.toFloat()), accuracy = (i.toFloat() + 1))
        }
        val gpx = makeGpx(pts)
        val smoothed = GpxPostProcessors.gaussianSmoothGpx(gpx)
        val parsed = GpxIO.parseGpxSegments(smoothed)
        for (i in pts.indices) {
            assertEquals("speed at index $i should be preserved",
                pts[i].speed, parsed.segments[0].points[i].speed)
            assertEquals("accuracy at index $i should be preserved",
                pts[i].accuracy, parsed.segments[0].points[i].accuracy)
        }
    }

    @Test
    fun gaussianSmoothGpx_returnsInputUnchanged_whenNoSegmentsFound() {
        // Malformed GPX → no <trkseg> → return raw input.
        val badGpx = "<?xml version=\"1.0\"?><gpx><notATrk></notATrk></gpx>"
        val result = GpxPostProcessors.gaussianSmoothGpx(badGpx)
        assertEquals(badGpx, result)
    }

    @Test
    fun gaussianSmoothGpx_preservesEmptyTrksegBlocks() {
        // Empty <trkseg> blocks should be preserved in the output so the
        // segment structure is mirrored.
        val gpx = StringBuilder()
            .append(GpxIO.gpxHeader())
            .append("  <trk>\n    <name>empty</name>\n")
            .append("    <trkseg></trkseg>\n")
            .append("  </trk>\n</gpx>\n")
            .toString()
        val smoothed = GpxPostProcessors.gaussianSmoothGpx(gpx)
        assertTrue("output should preserve the empty <trkseg>",
            smoothed.contains("<trkseg>"))
    }

    @Test
    fun gaussianSmoothGpx_weightedAveragesElevationCorrectly_L2Fix() {
        // L2 fix: elevation MUST be weighted-averaged just like lat/lon.
        // The previous implementation divided by the raw count of non-null
        // elevation points, which produced values ~40% of their true
        // magnitude. We verify the fix by smoothing 11 points whose
        // elevation is uniformly 100m — the smoothed elevation should
        // also be ~100m (not ~40m).
        val pts = (0..10).map { i ->
            pt(lat = 55.0 + i * 0.001, lon = 37.0, ele = 100.0, timeMs = i.toLong() * 1000L)
        }
        val gpx = makeGpx(pts)
        val smoothed = GpxPostProcessors.gaussianSmoothGpx(gpx)
        val parsed = GpxIO.parseGpxSegments(smoothed)
        // Pick a middle point (where the kernel is fully populated).
        val midElev = parsed.segments[0].points[5].ele
        assertNotNull("smoothed elevation should not be null", midElev)
        assertEquals("smoothed elevation should be ~100m (L2 fix), was $midElev",
            100.0, midElev!!, 1.0)
    }

    // ------------------------------------------------------------------
    // douglasPeuckerGpx
    // ------------------------------------------------------------------

    @Test
    fun douglasPeuckerGpx_reducesPointCountForNearStraightLine() {
        // 21 points along a perfectly straight line. With a moderate
        // epsilon (e.g. 5 m), only the endpoints should survive.
        val pts = (0..20).map { i ->
            pt(lat = 55.0, lon = 37.0 + i * 0.0001, timeMs = i.toLong() * 1000L)
        }
        val gpx = makeGpx(pts)
        val simplified = GpxPostProcessors.douglasPeuckerGpx(gpx, epsilonM = 5.0)
        val parsed = GpxIO.parseGpxSegments(simplified)
        // Should be 2 points (start + end) — all intermediate points
        // lie on the straight line and have cross-track distance ~0.
        assertEquals("near-straight line should reduce to 2 points",
            2, parsed.segments[0].points.size)
    }

    @Test
    fun douglasPeuckerGpx_preservesEndpointsOfEachSegment() {
        val pts = (0..10).map { i ->
            pt(lat = 55.0 + i * 0.001, lon = 37.0, timeMs = i.toLong() * 1000L)
        }
        val gpx = makeGpx(pts)
        val simplified = GpxPostProcessors.douglasPeuckerGpx(gpx, epsilonM = 1.0)
        val parsed = GpxIO.parseGpxSegments(simplified)
        val kept = parsed.segments[0].points
        assertEquals("first point preserved", pts.first().lat, kept.first().lat, 0.0001)
        assertEquals("last point preserved", pts.last().lat, kept.last().lat, 0.0001)
    }

    @Test
    fun douglasPeuckerGpx_preservesCornersForSmallEpsilon() {
        // 11 points forming an "L" shape: 5 along the equator east, then
        // a sharp 90° turn north. With a small epsilon, the corner
        // point MUST be kept.
        val pts = (0..10).map { i ->
            val lat = if (i < 5) 0.0 else (i - 4) * 0.001
            val lon = if (i < 5) i * 0.001 else 5 * 0.001
            pt(lat = lat, lon = lon, timeMs = i.toLong() * 1000L)
        }
        val gpx = makeGpx(pts)
        val simplified = GpxPostProcessors.douglasPeuckerGpx(gpx, epsilonM = 1.0)
        val parsed = GpxIO.parseGpxSegments(simplified)
        val kept = parsed.segments[0].points
        // The corner point (i=5) should be kept because its cross-track
        // distance from the line connecting (0,0) and (10, ...) is way
        // more than 1 m.
        assertTrue("corner point (lat=0.001) should be kept",
            kept.any { it.lat > 0.0001 })
    }

    @Test
    fun douglasPeuckerGpx_isIdempotent_runningTwiceEqualsRunningOnce() {
        val pts = (0..20).map { i ->
            // Slightly noisy line — some points off the straight line.
            val noise = if (i % 3 == 0) 0.0001 else 0.0
            pt(lat = 55.0 + noise, lon = 37.0 + i * 0.0001, timeMs = i.toLong() * 1000L)
        }
        val gpx = makeGpx(pts)
        val simplified1 = GpxPostProcessors.douglasPeuckerGpx(gpx, epsilonM = 5.0)
        val simplified2 = GpxPostProcessors.douglasPeuckerGpx(simplified1, epsilonM = 5.0)
        // The two outputs should have the same point count.
        val p1 = GpxIO.parseGpxSegments(simplified1)
        val p2 = GpxIO.parseGpxSegments(simplified2)
        assertEquals("running DP twice should not change the point count",
            p1.segments[0].points.size, p2.segments[0].points.size)
    }

    @Test
    fun douglasPeuckerGpx_returnsInputUnchanged_whenNoSegmentsFound() {
        val badGpx = "<?xml version=\"1.0\"?><gpx><notATrk></notATrk></gpx>"
        val result = GpxPostProcessors.douglasPeuckerGpx(badGpx, epsilonM = 5.0)
        assertEquals(badGpx, result)
    }

    @Test
    fun douglasPeuckerGpx_handlesEpsilonZero_asNoOp() {
        // epsilon <= 0 → keep all points verbatim.
        val pts = (0..10).map { i ->
            pt(lat = 55.0 + i * 0.001, lon = 37.0, timeMs = i.toLong() * 1000L)
        }
        val gpx = makeGpx(pts)
        val simplified = GpxPostProcessors.douglasPeuckerGpx(gpx, epsilonM = 0.0)
        val parsed = GpxIO.parseGpxSegments(simplified)
        assertEquals("epsilon=0 should keep all 11 points",
            11, parsed.segments[0].points.size)
    }

    @Test
    fun douglasPeuckerGpx_preservesSegmentStructure() {
        // Two segments — each should be simplified independently.
        val sb = StringBuilder()
        sb.append(GpxIO.gpxHeader())
        sb.append("  <trk>\n    <name>two-seg</name>\n")
        sb.append("    <trkseg>\n")
        for (i in 0..10) {
            sb.append(GpxIO.formatGpxPointWithInterpolated(
                pt(lat = 55.0 + i * 0.0001, lon = 37.0, timeMs = i.toLong() * 1000L)
            ))
        }
        sb.append("    </trkseg>\n    <trkseg>\n")
        for (i in 0..10) {
            sb.append(GpxIO.formatGpxPointWithInterpolated(
                pt(lat = 60.0 + i * 0.0001, lon = 38.0, timeMs = (i + 20).toLong() * 1000L)
            ))
        }
        sb.append("    </trkseg>\n  </trk>\n</gpx>\n")
        val gpx = sb.toString()
        val simplified = GpxPostProcessors.douglasPeuckerGpx(gpx, epsilonM = 5.0)
        val parsed = GpxIO.parseGpxSegments(simplified)
        assertEquals("both segments preserved", 2, parsed.segments.size)
        // Each segment should be reduced to 2 points (straight line).
        assertEquals("segment 1 reduced to 2 points", 2, parsed.segments[0].points.size)
        assertEquals("segment 2 reduced to 2 points", 2, parsed.segments[1].points.size)
    }

    // ------------------------------------------------------------------
    // douglasPeuckerSimplify (the direct list→list helper)
    // ------------------------------------------------------------------

    @Test
    fun douglasPeuckerSimplify_returnsInputListForFewerThan3Points() {
        val pts = listOf(
            pt(lat = 55.0, lon = 37.0, timeMs = 1_000L),
            pt(lat = 55.001, lon = 37.001, timeMs = 2_000L),
        )
        val result = GpxPostProcessors.douglasPeuckerSimplify(pts, epsilonM = 5.0)
        assertEquals(2, result.size)
    }

    @Test
    fun douglasPeuckerSimplify_returnsInputListForEpsilonZero() {
        val pts = (0..10).map { i ->
            pt(lat = 55.0 + i * 0.001, lon = 37.0, timeMs = i.toLong() * 1000L)
        }
        val result = GpxPostProcessors.douglasPeuckerSimplify(pts, epsilonM = 0.0)
        assertEquals(pts.size, result.size)
    }

    @Test
    fun douglasPeuckerSimplify_returnsInputListForNegativeEpsilon() {
        val pts = (0..10).map { i ->
            pt(lat = 55.0 + i * 0.001, lon = 37.0, timeMs = i.toLong() * 1000L)
        }
        val result = GpxPostProcessors.douglasPeuckerSimplify(pts, epsilonM = -5.0)
        assertEquals(pts.size, result.size)
    }

    @Test
    fun douglasPeuckerSimplify_keepsEndpointsAlways() {
        val pts = (0..10).map { i ->
            pt(lat = 55.0, lon = 37.0 + i * 0.0001, timeMs = i.toLong() * 1000L)
        }
        val result = GpxPostProcessors.douglasPeuckerSimplify(pts, epsilonM = 100.0)
        assertEquals("first point kept", pts.first().lat, result.first().lat, 0.0001)
        assertEquals("last point kept", pts.last().lat, result.last().lat, 0.0001)
    }

    @Test
    fun douglasPeuckerSimplify_handlesLargeInputWithoutStackOverflow() {
        // 10 000 points — the iterative (not recursive) implementation
        // should handle this without blowing the JVM stack.
        val pts = (0..9999).map { i ->
            pt(lat = 55.0, lon = 37.0 + i * 0.00001, timeMs = i.toLong() * 1000L)
        }
        val result = GpxPostProcessors.douglasPeuckerSimplify(pts, epsilonM = 5.0)
        // Should reduce to 2 points (all on a straight line).
        assertTrue("large input should reduce to ≤ 2 points for a straight line, got ${result.size}",
            result.size <= 2)
    }

    // ------------------------------------------------------------------
    // Gaussian constants
    // ------------------------------------------------------------------

    @Test
    fun gaussianConstants_haveExpectedValues() {
        assertEquals(5, GpxPostProcessors.GAUSSIAN_HALF_WINDOW)
        assertEquals(1.5, GpxPostProcessors.GAUUSSIAN_SIGMA, 0.0001)
    }

    // ------------------------------------------------------------------
    // maxDisplacementInWindow — wait, that's on AutoPauseGapController.
    // Skip — covered indirectly by the AutoPauseGapControllerTests.
    // ------------------------------------------------------------------
}

// Local helpers — assertNotNull on a non-null assertion.
private fun assertNotNull(message: String, value: Any?) {
    org.junit.Assert.assertNotNull(message, value)
}
