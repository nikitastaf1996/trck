package com.gpsrecorder

import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull

/**
 * Unit tests for [GpxIO] — the GPX parsing / formatting helper.
 *
 * Robolectric is required because [GpxIO] uses `android.util.Log` for
 * warnings and `org.xmlpull.v1.XmlPullParser` (which Robolectric
 * provides via the `kxml2` implementation bundled with the Android
 * framework jar).
 *
 * Coverage:
 *   - gpxHeader produces the standard GPX 1.1 prolog + namespaces.
 *   - formatGpxPoint emits a `<trkpt>` element with lat/lon/time and
 *     optional ele/speed/accuracy/interpolated children.
 *   - serializeSegmentsToGpx drops single-point segments (L17 fix).
 *   - parseGpxSegments round-trips a serialized GPX (parse what we
 *     serialize and check the point count matches).
 *   - parseGpxSegments skips points with missing lat/lon/time (L21 fix).
 *   - isoTime / parseIsoTime are inverse functions.
 *   - countTrkpt counts `<trkpt>` occurrences in a string.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])  // Robolectric doesn't yet support SDK 35; 33 is the closest stable.
class GpxIOTest {

    // ------------------------------------------------------------------
    // gpxHeader
    // ------------------------------------------------------------------

    @Test
    fun gpxHeader_containsXmlDeclarationAndGpxElement() {
        val h = GpxIO.gpxHeader()
        assertTrue("header should contain <?xml", h.contains("<?xml version=\"1.0\""))
        assertTrue("header should contain <gpx", h.contains("<gpx"))
        assertTrue("header should contain version=1.1", h.contains("version=\"1.1\""))
    }

    @Test
    fun gpxHeader_containsGpxNamespaces() {
        val h = GpxIO.gpxHeader()
        assertTrue("header should contain topografix namespace",
            h.contains("xmlns=\"http://www.topografix.com/GPX/1/1\""))
        assertTrue("header should contain xsi namespace",
            h.contains("xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\""))
    }

    @Test
    fun gpxHeader_containsMetadataTimeElement() {
        val h = GpxIO.gpxHeader()
        assertTrue("header should contain <metadata><time>",
            h.contains("<metadata><time>") && h.contains("</time></metadata>"))
    }

    @Test
    fun gpxHeader_emitsAValidIsoTimestamp() {
        val h = GpxIO.gpxHeader()
        // Extract the timestamp between <metadata><time> and </time></metadata>.
        val match = Regex("<metadata><time>([^<]+)</time></metadata>").find(h)
        assertNotNull("header should contain a parseable timestamp", match)
        val ts = match!!.groupValues[1]
        // The ISO format is "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'".
        assertTrue("timestamp should end with 'Z' (UTC), was $ts", ts.endsWith("Z"))
        // Round-trip the timestamp through parseIsoTime — should not be null.
        val parsed = GpxIO.parseIsoTime(ts)
        assertNotNull("parseIsoTime should round-trip the header timestamp", parsed)
    }

    // ------------------------------------------------------------------
    // formatGpxPoint
    // ------------------------------------------------------------------

    @Test
    fun formatGpxPoint_emitsTrkptElementWithLatAndLon() {
        val p = GpsPoint(lat = 55.0, lon = 37.0, alt = null, speed = null, accuracy = null, timeMs = 1_000L)
        val s = GpxIO.formatGpxPoint(p)
        assertTrue("output should contain <trkpt", s.contains("<trkpt"))
        assertTrue("output should contain lat=55.0", s.contains("lat=\"55.0\""))
        assertTrue("output should contain lon=37.0", s.contains("lon=\"37.0\""))
    }

    @Test
    fun formatGpxPoint_emitsTimeChildElement() {
        val p = GpsPoint(55.0, 37.0, null, null, null, 1_000L)
        val s = GpxIO.formatGpxPoint(p)
        assertTrue("output should contain <time>", s.contains("<time>") && s.contains("</time>"))
    }

    @Test
    fun formatGpxPoint_emitsEleChildElement_whenAltIsNotNull() {
        val p = GpsPoint(55.0, 37.0, alt = 100.0, null, null, 1_000L)
        val s = GpxIO.formatGpxPoint(p)
        assertTrue("output should contain <ele>100.0</ele>", s.contains("<ele>100.0</ele>"))
    }

    @Test
    fun formatGpxPoint_omitsEleChildElement_whenAltIsNull() {
        val p = GpsPoint(55.0, 37.0, alt = null, null, null, 1_000L)
        val s = GpxIO.formatGpxPoint(p)
        assertFalse("output should NOT contain <ele>", s.contains("<ele>"))
    }

    @Test
    fun formatGpxPoint_emitsSpeedChildElement_whenSpeedIsNotNull() {
        val p = GpsPoint(55.0, 37.0, null, speed = 3.5f, null, 1_000L)
        val s = GpxIO.formatGpxPoint(p)
        assertTrue("output should contain <speed>", s.contains("<speed>"))
    }

    @Test
    fun formatGpxPoint_emitsAccuracyInExtensions_whenAccuracyIsNotNull() {
        val p = GpsPoint(55.0, 37.0, null, null, accuracy = 5.0f, 1_000L)
        val s = GpxIO.formatGpxPoint(p)
        assertTrue("output should contain <extensions>", s.contains("<extensions>"))
        assertTrue("output should contain <accuracy>5.0</accuracy>", s.contains("<accuracy>5.0</accuracy>"))
    }

    @Test
    fun formatGpxPoint_omitsExtensionsBlock_whenAccuracyIsNull() {
        val p = GpsPoint(55.0, 37.0, null, null, accuracy = null, 1_000L)
        val s = GpxIO.formatGpxPoint(p)
        assertFalse("output should NOT contain <extensions>", s.contains("<extensions>"))
    }

    // ------------------------------------------------------------------
    // formatGpxPointWithInterpolated
    // ------------------------------------------------------------------

    @Test
    fun formatGpxPointWithInterpolated_emitsInterpolatedTrue_whenInterpolatedIsTrue() {
        val p = GpxIO.GpxTrkPt(lat = 55.0, lon = 37.0, ele = null, speed = null, accuracy = null, timeMs = 1_000L, interpolated = true)
        val s = GpxIO.formatGpxPointWithInterpolated(p)
        assertTrue("output should contain <interpolated>true</interpolated>",
            s.contains("<interpolated>true</interpolated>"))
    }

    @Test
    fun formatGpxPointWithInterpolated_omitsInterpolatedElement_whenFalse() {
        val p = GpxIO.GpxTrkPt(55.0, 37.0, null, null, null, 1_000L, interpolated = false)
        val s = GpxIO.formatGpxPointWithInterpolated(p)
        assertFalse("output should NOT contain <interpolated>",
            s.contains("<interpolated>"))
    }

    @Test
    fun formatGpxPointWithInterpolated_emitsExtensionsBlock_whenInterpolatedIsTrue_evenIfAccuracyIsNull() {
        // Per the source: "Synthetic points have no accuracy, so we always
        // emit <extensions> for them."
        val p = GpxIO.GpxTrkPt(55.0, 37.0, null, null, accuracy = null, timeMs = 1_000L, interpolated = true)
        val s = GpxIO.formatGpxPointWithInterpolated(p)
        assertTrue(s.contains("<extensions>"))
        assertTrue(s.contains("<interpolated>true</interpolated>"))
    }

    // ------------------------------------------------------------------
    // serializeSegmentsToGpx
    // ------------------------------------------------------------------

    @Test
    fun serializeSegmentsToGpx_emitsWellFormedGpxDocument() {
        val seg1 = listOf(
            GpsPoint(55.0, 37.0, null, null, null, 1_000L),
            GpsPoint(55.001, 37.001, null, null, null, 2_000L),
        )
        val seg2 = listOf(
            GpsPoint(56.0, 38.0, null, null, null, 3_000L),
            GpsPoint(56.001, 38.001, null, null, null, 4_000L),
        )
        val gpx = GpxIO.serializeSegmentsToGpx("test-track", listOf(seg1, seg2))
        assertTrue("output should contain <?xml", gpx.contains("<?xml"))
        assertTrue("output should contain <gpx", gpx.contains("<gpx"))
        assertTrue("output should contain <trk>", gpx.contains("<trk>"))
        assertTrue("output should contain <name>test-track</name>", gpx.contains("<name>test-track</name>"))
        assertTrue("output should contain two <trkseg> blocks",
            Regex("<trkseg>").findAll(gpx).count() == 2)
        assertTrue("output should contain 4 <trkpt> elements",
            GpxIO.countTrkpt(gpx) == 4)
    }

    @Test
    fun serializeSegmentsToGpx_dropsSinglePointSegments_alwaysPerL17Fix() {
        // L17: even if ALL segments are single-point, none should be emitted.
        val seg1 = listOf(GpsPoint(55.0, 37.0, null, null, null, 1_000L))
        val seg2 = listOf(GpsPoint(56.0, 38.0, null, null, null, 2_000L))
        val gpx = GpxIO.serializeSegmentsToGpx("test", listOf(seg1, seg2))
        assertTrue("output should NOT contain any <trkseg> (all single-point segments dropped)",
            !gpx.contains("<trkseg>"))
        assertTrue("output should still contain <trk> wrapper",
            gpx.contains("<trk>") && gpx.contains("</trk>"))
    }

    @Test
    fun serializeSegmentsToGpx_dropsEmptySegments() {
        val seg1 = listOf(
            GpsPoint(55.0, 37.0, null, null, null, 1_000L),
            GpsPoint(55.001, 37.001, null, null, null, 2_000L),
        )
        val empty = listOf<GpsPoint>()
        val gpx = GpxIO.serializeSegmentsToGpx("test", listOf(seg1, empty))
        assertTrue("output should contain only one <trkseg>",
            Regex("<trkseg>").findAll(gpx).count() == 1)
        assertEquals(2, GpxIO.countTrkpt(gpx))
    }

    @Test
    fun serializeSegmentsToGpx_handlesNoSegmentsCase() {
        // Empty list → <trk> wrapper with no <trkseg>.
        val gpx = GpxIO.serializeSegmentsToGpx("empty", emptyList())
        assertTrue("output should contain <trk>", gpx.contains("<trk>"))
        assertTrue("output should NOT contain <trkseg>", !gpx.contains("<trkseg>"))
    }

    // ------------------------------------------------------------------
    // parseGpxSegments — round-trip tests
    // ------------------------------------------------------------------

    @Test
    fun parseGpxSegments_roundTripsASerializedGpx() {
        val seg1 = listOf(
            GpsPoint(55.0, 37.0, 100.0, 3.0f, 5.0f, 1_000L),
            GpsPoint(55.001, 37.001, 102.0, 3.1f, 5.0f, 2_000L),
            GpsPoint(55.002, 37.002, 104.0, 3.2f, 5.0f, 3_000L),
        )
        val gpx = GpxIO.serializeSegmentsToGpx("round-trip", listOf(seg1))
        val parsed = GpxIO.parseGpxSegments(gpx)
        // 1 segment, 3 points, 0 skipped.
        assertEquals(1, parsed.segments.size)
        assertEquals(3, parsed.segments[0].points.size)
        assertEquals(0, parsed.skippedPointCount)
        assertEquals(3, parsed.totalPointCount)
        // Verify the first point's fields.
        val first = parsed.segments[0].points[0]
        assertEquals(55.0, first.lat, 0.0001)
        assertEquals(37.0, first.lon, 0.0001)
        assertEquals(100.0, first.ele!!, 0.0001)
        assertEquals(1_000L, first.timeMs)
    }

    @Test
    fun parseGpxSegments_handlesMultipleSegments() {
        val seg1 = listOf(
            GpsPoint(55.0, 37.0, null, null, null, 1_000L),
            GpsPoint(55.001, 37.001, null, null, null, 2_000L),
        )
        val seg2 = listOf(
            GpsPoint(56.0, 38.0, null, null, null, 3_000L),
            GpsPoint(56.001, 38.001, null, null, null, 4_000L),
        )
        val gpx = GpxIO.serializeSegmentsToGpx("multi", listOf(seg1, seg2))
        val parsed = GpxIO.parseGpxSegments(gpx)
        assertEquals(2, parsed.segments.size)
        assertEquals(2, parsed.segments[0].points.size)
        assertEquals(2, parsed.segments[1].points.size)
        assertEquals(0, parsed.skippedPointCount)
        assertEquals(4, parsed.totalPointCount)
    }

    @Test
    fun parseGpxSegments_skipsPointsWithMissingTime() {
        // L21 fix: a <trkpt> with no <time> child is skipped.
        val gpx = """
            <?xml version="1.0" encoding="UTF-8"?>
            <gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
              <trk>
                <name>skip-test</name>
                <trkseg>
                  <trkpt lat="55.0" lon="37.0">
                    <ele>100.0</ele>
                    <time>1970-01-01T00:00:01.000Z</time>
                  </trkpt>
                  <trkpt lat="56.0" lon="38.0">
                    <!-- missing <time> -->
                    <ele>200.0</ele>
                  </trkpt>
                </trkseg>
              </trk>
            </gpx>
        """.trimIndent()
        val parsed = GpxIO.parseGpxSegments(gpx)
        assertEquals(1, parsed.segments.size)
        assertEquals(1, parsed.segments[0].points.size)
        assertEquals(1, parsed.skippedPointCount)
        assertEquals(2, parsed.totalPointCount)
    }

    @Test
    fun parseGpxSegments_skipsPointsWithMissingLatOrLon() {
        val gpx = """
            <?xml version="1.0" encoding="UTF-8"?>
            <gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
              <trk>
                <name>skip-test</name>
                <trkseg>
                  <trkpt lat="55.0" lon="37.0">
                    <time>1970-01-01T00:00:01.000Z</time>
                  </trkpt>
                  <trkpt lat="abc" lon="38.0">
                    <time>1970-01-01T00:00:02.000Z</time>
                  </trkpt>
                  <trkpt lat="57.0" lon="xyz">
                    <time>1970-01-01T00:00:03.000Z</time>
                  </trkpt>
                </trkseg>
              </trk>
            </gpx>
        """.trimIndent()
        val parsed = GpxIO.parseGpxSegments(gpx)
        assertEquals(1, parsed.segments.size)
        assertEquals(1, parsed.segments[0].points.size)
        assertEquals(2, parsed.skippedPointCount)
        assertEquals(3, parsed.totalPointCount)
    }

    @Test
    fun parseGpxSegments_returnsEmptyOnMalformedXml() {
        // When XmlPullParser throws, the helper catches and returns a
        // partial (empty) result rather than crashing the caller.
        val gpx = "<?xml this is not valid XML"
        val parsed = GpxIO.parseGpxSegments(gpx)
        assertEquals(0, parsed.segments.size)
        assertEquals(0, parsed.totalPointCount)
    }

    @Test
    fun parseGpxSegments_handlesEmptyTrksegBlocks() {
        val gpx = """
            <?xml version="1.0" encoding="UTF-8"?>
            <gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
              <trk>
                <name>empty-segs</name>
                <trkseg></trkseg>
                <trkseg></trkseg>
              </trk>
            </gpx>
        """.trimIndent()
        val parsed = GpxIO.parseGpxSegments(gpx)
        assertEquals(2, parsed.segments.size) // two empty segments preserved
        assertEquals(0, parsed.segments[0].points.size)
        assertEquals(0, parsed.segments[1].points.size)
        assertEquals(0, parsed.totalPointCount)
    }

    // ------------------------------------------------------------------
    // isoTime / parseIsoTime
    // ------------------------------------------------------------------

    @Test
    fun isoTime_emitsExpectedFormat() {
        // 1970-01-01T00:00:01.000Z for timeMs=1000.
        val s = GpxIO.isoTime(1_000L)
        assertEquals("1970-01-01T00:00:01.000Z", s)
    }

    @Test
    fun isoTime_handlesLargeTimestamps() {
        // 2026-01-01T00:00:00.000Z = 1767225600000 ms (UTC).
        val s = GpxIO.isoTime(1_767_225_600_000L)
        assertTrue("expected 2026-01-01T00:00:00.000Z, got $s",
            s.startsWith("2026-01-01T00:00:00"))
        assertTrue(s.endsWith("Z"))
    }

    @Test
    fun parseIsoTime_returnsNullForNull() {
        assertNull(GpxIO.parseIsoTime(null))
    }

    @Test
    fun parseIsoTime_returnsNullForMalformedInput() {
        assertNull(GpxIO.parseIsoTime("not-a-date"))
        assertNull(GpxIO.parseIsoTime(""))
        assertNull(GpxIO.parseIsoTime("1970-01-01")) // missing time component
    }

    @Test
    fun parseIsoTime_roundTripsIsoTime() {
        val ts = 1_767_225_600_000L
        val s = GpxIO.isoTime(ts)
        val parsed = GpxIO.parseIsoTime(s)
        assertEquals(ts, parsed)
    }

    // ------------------------------------------------------------------
    // countTrkpt
    // ------------------------------------------------------------------

    @Test
    fun countTrkpt_countsOccurrencesOfTrkptStartTag() {
        val gpx = """
            <gpx>
              <trk><trkseg>
                <trkpt lat="1" lon="2"></trkpt>
                <trkpt lat="3" lon="4"></trkpt>
                <trkpt lat="5" lon="6"></trkpt>
              </trkseg></trk>
            </gpx>
        """.trimIndent()
        assertEquals(3, GpxIO.countTrkpt(gpx))
    }

    @Test
    fun countTrkpt_returnsZeroForNoTrkpt() {
        val gpx = "<gpx></gpx>"
        assertEquals(0, GpxIO.countTrkpt(gpx))
    }

    @Test
    fun countTrkpt_returnsZeroForEmptyString() {
        assertEquals(0, GpxIO.countTrkpt(""))
    }
}
