package com.gpsrecorder

import android.util.Log
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory
import java.io.InputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * O7 / O24 — Pure GPX parsing + formatting helpers extracted from
 * GpsRecorderService.kt.
 *
 * Every function in this object is pure (no Android service state, no
 * SharedPreferences, no side effects except logging) and main-thread-safe
 * via the shared [ISO_SDF] / [FILENAME_SDF] SimpleDateFormat instances
 * (see L32 comment below).
 *
 * The service delegates to these helpers via `GpxIO.xxx(...)`. Extracted
 * to shrink GpsRecorderService.kt and make the GPX layer unit-testable.
 */
object GpxIO {

    private const val TAG = "GpsRecorderService"

    // ---- L32: shared SimpleDateFormat instances ----
    // SimpleDateFormat is not thread-safe, but every call site in
    // this service runs on the main thread (location callbacks, tick
    // handlers, lifecycle methods), so a single shared instance per
    // format is safe. If we ever call from a background thread,
    // switch to ThreadLocal.
    val ISO_SDF: SimpleDateFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }
    val FILENAME_SDF: SimpleDateFormat = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US)

    // ---- L26: append-only temp file ----
    // Closing tags written at the end of every flush so the temp
    // file is always a complete, parseable GPX document (recoverable
    // on crash). Before appending new points / segment breaks, we
    // truncate these closing tags via RandomAccessFile.setLength.
    const val TEMP_FILE_CLOSING_TAGS = "    </trkseg>\n  </trk>\n</gpx>\n"
    val TEMP_FILE_CLOSING_TAGS_BYTES = TEMP_FILE_CLOSING_TAGS.toByteArray(Charsets.UTF_8)

    /**
     * Lightweight trkpt representation used by the post-processing pipeline.
     * Carries an [interpolated] flag so synthetic points can be tagged in the
     * output GPX.
     */
    data class GpxTrkPt(
        val lat: Double,
        val lon: Double,
        val ele: Double?,
        val speed: Float?,
        val accuracy: Float?,
        val timeMs: Long,
        val interpolated: Boolean = false
    )

    /**
     * L30 fix: a parsed GPX segment, used by the new XmlPullParser-based
     * helper. Each segment is a list of [GpxTrkPt]. Points whose timestamp
     * could not be parsed (L21) are dropped from this list and counted in
     * [GpxParseResult.skippedPointCount] so callers can decide whether to
     * abort.
     */
    data class GpxSegment(val points: List<GpxTrkPt>)

    /**
     * L30 / L21: result of parsing a GPX document. [segments] holds the
     * successfully-parsed points grouped by <trkseg>. [skippedPointCount]
     * is the number of <trkpt> elements that were dropped because their
     * timestamp (or lat/lon) couldn't be parsed. [totalPointCount] is the
     * total number of <trkpt> elements seen (parsed + skipped), used by
     * callers to compute the skip ratio.
     */
    data class GpxParseResult(
        val segments: List<GpxSegment>,
        val skippedPointCount: Int,
        val totalPointCount: Int
    )

    // ------------------------------------------------------------------
    // GPX formatting
    // ------------------------------------------------------------------

    /**
     * Returns the GPX 1.1 document header (XML declaration, `<gpx>` element
     * with the standard namespaces, and a `<metadata><time>` element with
     * the current ISO-8601 timestamp).
     */
    fun gpxHeader(): String {
        val nowIso = isoTime(System.currentTimeMillis())
        return StringBuilder()
            .append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
            .append("<gpx version=\"1.1\" creator=\"GpsRecorder\" ")
            .append("xmlns=\"http://www.topografix.com/GPX/1/1\" ")
            .append("xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" ")
            .append("xsi:schemaLocation=\"http://www.topografix.com/GPX/1/1 ")
            .append("http://www.topografix.com/GPX/1/1/gpx.xsd\">\n")
            .append("  <metadata><time>").append(nowIso).append("</time></metadata>\n")
            .toString()
    }

    /**
     * Formats a [GpsPoint] as a `<trkpt>` XML element with optional `<ele>`,
     * `<speed>`, and `<accuracy>` (under `<extensions>`) child tags.
     */
    fun formatGpxPoint(p: GpsPoint): String {
        val sb = StringBuilder()
        sb.append("      <trkpt lat=\"").append(p.lat).append("\" lon=\"").append(p.lon).append("\">\n")
        if (p.alt != null) {
            sb.append("        <ele>").append(p.alt).append("</ele>\n")
        }
        sb.append("        <time>").append(isoTime(p.timeMs)).append("</time>\n")
        if (p.speed != null) {
            // GPX speed is in m/s
            sb.append("        <speed>").append(p.speed).append("</speed>\n")
        }
        if (p.accuracy != null) {
            // There's no standard GPX tag for accuracy; we use <extensions> with a custom
            // namespace so it's still valid GPX but the accuracy info is preserved.
            sb.append("        <extensions>\n")
            sb.append("          <accuracy>").append(p.accuracy).append("</accuracy>\n")
            sb.append("        </extensions>\n")
        }
        sb.append("      </trkpt>\n")
        return sb.toString()
    }

    /**
     * Like [formatGpxPoint] but also emits an `<interpolated>true</interpolated>`
     * tag inside `<extensions>` when [p.interpolated] is true. Synthetic points
     * have no accuracy, so we always emit `<extensions>` for them.
     */
    fun formatGpxPointWithInterpolated(p: GpxTrkPt): String {
        val sb = StringBuilder()
        sb.append("      <trkpt lat=\"").append(p.lat).append("\" lon=\"").append(p.lon).append("\">\n")
        if (p.ele != null) {
            sb.append("        <ele>").append(p.ele).append("</ele>\n")
        }
        sb.append("        <time>").append(isoTime(p.timeMs)).append("</time>\n")
        if (p.speed != null) {
            sb.append("        <speed>").append(p.speed).append("</speed>\n")
        }
        if (p.accuracy != null || p.interpolated) {
            sb.append("        <extensions>\n")
            if (p.accuracy != null) {
                sb.append("          <accuracy>").append(p.accuracy).append("</accuracy>\n")
            }
            if (p.interpolated) {
                sb.append("          <interpolated>true</interpolated>\n")
            }
            sb.append("        </extensions>\n")
        }
        sb.append("      </trkpt>\n")
        return sb.toString()
    }

    /**
     * Serializes all current segments (finalized + current) as a complete GPX
     * document. Each segment becomes its own `<trkseg>` block so that pauses /
     * gaps appear as clean segment breaks in the output file (no straight-
     * line "stitches" across them). Empty segments are omitted.
     *
     * L17 fix: single-point segments are ALWAYS dropped. The previous code
     * kept them when no segment had ≥ 2 points (a rare edge case where a
     * recording consisted entirely of 1-point segments), producing a GPX
     * with multiple useless 1-point `<trkseg>` blocks — exactly the pattern
     * the comment below said it was trying to avoid. If this leaves zero
     * segments, the GPX contains just `<trk></trk>` (no `<trkseg>`), matching
     * the existing behavior for fully-empty recordings.
     *
     * A 1-point `<trkseg>` is useless to consumers (Strava, OSM, etc. — they
     * need at least 2 points to draw a line) and was a side-effect of the
     * gap-recovery + auto-pause interaction: a fix arrived right after a
     * gap, briefly looked like movement (so it was appended to a fresh
     * post-gap segment), and then auto-pause immediately triggered
     * (splitting that 1-point segment off). Dropping such segments at
     * serialization time is safe because a single point has no neighbours
     * to form a line with — its spatial contribution to the track is zero.
     */
    fun serializeSegmentsToGpx(name: String, segments: List<List<GpsPoint>>): String {
        val sb = StringBuilder()
        sb.append(gpxHeader())
        sb.append("  <trk>\n")
        sb.append("    <name>").append(name).append("</name>\n")
        // L17 fix: ALWAYS drop segments with < 2 points. If this leaves
        // zero <trkseg> blocks, that's fine — the <trk> wrapper is still
        // emitted so the GPX document is well-formed.
        for (seg in segments) {
            if (seg.size < 2) continue  // always drop 1-point and empty segments
            sb.append("    <trkseg>\n")
            for (p in seg) {
                sb.append(formatGpxPoint(p))
            }
            sb.append("    </trkseg>\n")
        }
        sb.append("  </trk>\n")
        sb.append("</gpx>\n")
        return sb.toString()
    }

    // ------------------------------------------------------------------
    // GPX parsing
    // ------------------------------------------------------------------

    /**
     * L30 fix: shared XmlPullParser-based GPX parser. Replaces the regex-
     * based parsing in reloadPointsFromTempFile / recomputeDistanceFromSavedGpx
     * / gaussianSmoothGpx / douglasPeuckerGpx. Handles CDATA, comments, and
     * attribute order variations that the regex would have failed on.
     *
     * L21 fix: points whose `<time>` tag is missing or unparseable are dropped
     * from the returned segments and counted in [GpxParseResult.skippedPointCount].
     * Callers can decide whether to abort if the skip ratio is too high
     * (see GpsRecorderService.RELOAD_BAD_TIMESTAMP_ABORT_FRACTION).
     *
     * Points with missing or unparseable lat/lon attributes are also dropped
     * (same accounting).
     */
    fun parseGpxSegments(input: InputStream): GpxParseResult {
        val segments = mutableListOf<GpxSegment>()
        var skipped = 0
        var total = 0
        try {
            val parser = XmlPullParserFactory.newInstance().newPullParser()
            parser.setInput(input, "UTF-8")
            var currentSegment: MutableList<GpxTrkPt>? = null
            var curLat: Double? = null
            var curLon: Double? = null
            var curEle: Double? = null
            var curSpeed: Float? = null
            var curAcc: Float? = null
            var curTimeIso: String? = null
            var event = parser.eventType
            while (event != XmlPullParser.END_DOCUMENT) {
                when (event) {
                    XmlPullParser.START_TAG -> {
                        when (parser.name) {
                            "trkseg" -> currentSegment = mutableListOf()
                            "trkpt" -> {
                                curLat = parser.getAttributeValue(null, "lat")?.toDoubleOrNull()
                                curLon = parser.getAttributeValue(null, "lon")?.toDoubleOrNull()
                                curEle = null
                                curSpeed = null
                                curAcc = null
                                curTimeIso = null
                            }
                            "ele" -> curEle = parser.nextText().toDoubleOrNull()
                            "speed" -> curSpeed = parser.nextText().toFloatOrNull()
                            "accuracy" -> curAcc = parser.nextText().toFloatOrNull()
                            "time" -> curTimeIso = parser.nextText()
                        }
                    }
                    XmlPullParser.END_TAG -> {
                        when (parser.name) {
                            "trkseg" -> {
                                currentSegment?.let { segments.add(GpxSegment(it)) }
                                currentSegment = null
                            }
                            "trkpt" -> {
                                total++
                                val lat = curLat
                                val lon = curLon
                                val timeMs = parseIsoTime(curTimeIso)
                                if (lat == null || lon == null || timeMs == null || currentSegment == null) {
                                    // L21 fix: skip points with missing /
                                    // unparseable lat / lon / time.
                                    skipped++
                                } else {
                                    currentSegment!!.add(
                                        GpxTrkPt(lat, lon, curEle, curSpeed, curAcc, timeMs, interpolated = false)
                                    )
                                }
                            }
                        }
                    }
                }
                event = parser.next()
            }
        } catch (e: Exception) {
            Log.w(TAG, "parseGpxSegments: XmlPullParser failed (returning partial result)", e)
        }
        return GpxParseResult(segments, skipped, total)
    }

    /** Convenience overload for parsing a String. */
    fun parseGpxSegments(text: String): GpxParseResult {
        return parseGpxSegments(text.byteInputStream(Charsets.UTF_8))
    }

    /** Counts `<trkpt>` elements in a GPX document (used for post-process logging). */
    fun countTrkpt(gpx: String): Int {
        return Regex("<trkpt ").findAll(gpx).count()
    }

    fun isoTime(ms: Long): String {
        // L32 fix: use the shared singleton SimpleDateFormat instead
        // of allocating a new one on every call.
        return ISO_SDF.format(Date(ms))
    }

    fun parseIsoTime(iso: String?): Long? {
        // L32 fix: use the shared singleton SimpleDateFormat instead
        // of allocating a new one on every call.
        if (iso == null) return null
        return try {
            ISO_SDF.parse(iso)?.time
        } catch (e: Exception) {
            null
        }
    }
}
