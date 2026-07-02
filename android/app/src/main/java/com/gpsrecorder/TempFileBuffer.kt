package com.gpsrecorder

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

/**
 * O7 / O24 (round 2) — Append-only temp-file buffering extracted from
 * GpsRecorderService.kt.
 *
 * Encapsulates the L26 append-only strategy:
 *   - [writeGpxHeader] writes the GPX header + `<trk>` + first `<trkseg>`
 *     + closing tags once at the start of a recording.
 *   - [flush] truncates the trailing closing tags, appends new `<trkpt>`
 *     elements + any new `</trkseg><trkseg>` segment boundaries, then
 *     re-appends the closing tags. The temp file is ALWAYS a complete,
 *     parseable GPX document (recoverable on crash).
 *   - [reloadPointsIntoBuffer] parses the temp file back into the
 *     segmented buffer on START_STICKY restart.
 *
 * State owned: `tempFileName`, `tempFileInitialized`,
 * `tempFileFlushedSegments`, `tempFileFlushedCurrentSize`.
 *
 * State NOT owned (passed in via callbacks):
 *   - `segmentsSnapshot: () -> List<List<GpsPoint>>` — snapshot of the
 *     in-memory segmented buffer (under the service's `pointBufferLock`).
 *   - `setBuffer` — callback to replace the in-memory buffer with the
 *     reloaded segments (used by [reloadPointsIntoBuffer]).
 *   - `setAppendState` — callback to reset / sync the append-only state
 *     after a reload or abort.
 *
 * L26 invariant preserved: every flush produces a complete, parseable GPX
 * document. If anything goes wrong (file deleted, IO error, state
 * corruption), we fall back to a full rewrite via [fullRewrite].
 *
 * L21 invariant preserved: [reloadPointsIntoBuffer] aborts if >10% of
 * points have unparseable timestamps, leaving the buffer empty.
 */
class TempFileBuffer(
    private val service: GpsRecorderService,
    private val segmentsSnapshot: () -> List<List<GpsPoint>>,
    private val setBuffer: (List<List<GpsPoint>>, Int) -> Unit,
    private val setAppendState: (initialized: Boolean, flushedSegments: Int, flushedCurrentSize: Int) -> Unit,
) {

    private val tag: String get() = GpsRecorderService.TAG

    @Volatile var tempFileName: String? = null
    @Volatile var tempFileInitialized: Boolean = false
        private set
    @Volatile var tempFileFlushedSegments: Int = 0
        private set
    @Volatile var tempFileFlushedCurrentSize: Int = 0
        private set

    fun resetState() {
        tempFileInitialized = false
        tempFileFlushedSegments = 0
        tempFileFlushedCurrentSize = 0
    }

    fun getTempFile(): File {
        val name = tempFileName ?: "gps_temp_unknown.gpx"
        return File(service.externalCacheDir ?: service.cacheDir, name)
    }

    /**
     * Writes the GPX header + opening `<trk>` + `<name>` + first opening
     * `<trkseg>` to the temp file, replacing any previous content. The temp
     * file lives in the app's cache dir so it survives the JS app being
     * killed but is private to the app.
     *
     * L26 fix (preserved): this is the FIRST write of the append-only
     * strategy. We open the first `<trkseg>` here so subsequent flushes can
     * just append `<trkpt>` elements. Segment boundaries
     * (`</trkseg><trkseg>`) are appended on the fly as new segments appear
     * in memory. Closing tags (`</trkseg></trk></gpx>`) are written at the
     * end of every flush so the temp file is always a complete, parseable
     * GPX document (recoverable on crash).
     */
    fun writeGpxHeader() {
        try {
            val f = getTempFile()
            FileOutputStream(f).use { out ->
                out.write(GpxIO.gpxHeader().toByteArray(Charsets.UTF_8))
                out.write("  <trk>\n    <name>GPS Recording</name>\n".toByteArray(Charsets.UTF_8))
                out.write("    <trkseg>\n".toByteArray(Charsets.UTF_8))
                out.write(GpxIO.TEMP_FILE_CLOSING_TAGS_BYTES)
            }
            tempFileInitialized = true
            tempFileFlushedSegments = 1  // one <trkseg> opened
            tempFileFlushedCurrentSize = 0
        } catch (e: Exception) {
            Log.e(tag, "writeGpxHeader failed", e)
            tempFileInitialized = false
        }
    }

    /**
     * L26 helper: truncates the trailing closing tags
     * (`</trkseg></trk></gpx>`) from the temp file so we can append new
     * points / segment breaks. Uses `RandomAccessFile.setLength` for O(1)
     * truncate. If the file is shorter than the closing tags (shouldn't
     * happen, but be defensive), we fall back to a full rewrite.
     */
    private fun truncateTempFileClosingTags(f: File): Boolean {
        return try {
            val len = f.length()
            if (len < GpxIO.TEMP_FILE_CLOSING_TAGS_BYTES.size) {
                Log.w(tag, "truncateTempFileClosingTags: file too short ($len bytes) — falling back to full rewrite")
                return false
            }
            RandomAccessFile(f, "rw").use { raf ->
                raf.setLength(len - GpxIO.TEMP_FILE_CLOSING_TAGS_BYTES.size)
            }
            true
        } catch (e: Exception) {
            Log.w(tag, "truncateTempFileClosingTags failed — falling back to full rewrite", e)
            false
        }
    }

    /**
     * L26 fallback: if the append-only strategy fails for any reason (file
     * deleted externally, IO error, state corruption), fall back to the
     * original full-rewrite strategy. This is slower (O(n²) over the
     * recording) but always produces a correct temp file.
     */
    private fun fullRewrite() {
        try {
            val segments = segmentsSnapshot()
            val content = GpxIO.serializeSegmentsToGpx("GPS Recording", segments)
            val f = getTempFile()
            FileOutputStream(f).use { out ->
                out.write(content.toByteArray(Charsets.UTF_8))
            }
            // Reset the append-only state so the next flush starts fresh.
            tempFileInitialized = true
            tempFileFlushedSegments = segments.size
            tempFileFlushedCurrentSize = segments.lastOrNull()?.size ?: 0
        } catch (e: Exception) {
            Log.e(tag, "fullRewrite failed", e)
        }
    }

    /**
     * Flushes the current in-memory points to the temp file.
     *
     * L26 strategy (preserved):
     *   1. On `writeGpxHeader`: write header + `<trk>` + `<name>` + first
     *      `<trkseg>` + closing tags.
     *   2. On each flush: truncate closing tags, append new `<trkpt>`
     *      elements, append closing tags. If new segments have appeared
     *      since the last flush, append `</trkseg><trkseg>` boundaries.
     *   3. The temp file is ALWAYS a complete, parseable GPX document
     *      (closing tags are re-written at the end of every flush) so
     *      `reloadPointsIntoBuffer()` can parse it on crash recovery.
     */
    fun flush() {
        try {
            val f = getTempFile()
            if (!tempFileInitialized || !f.exists()) {
                fullRewrite()
                return
            }

            val snapshot = segmentsSnapshot()
            val totalSegments = snapshot.size

            val sb = StringBuilder()
            var openedNewSegments = false
            if (totalSegments > tempFileFlushedSegments) {
                for (i in tempFileFlushedSegments until totalSegments) {
                    sb.append("    </trkseg>\n")
                    sb.append("    <trkseg>\n")
                }
                openedNewSegments = true
                tempFileFlushedSegments = totalSegments
                tempFileFlushedCurrentSize = 0
            }

            val currentPoints = snapshot.lastOrNull() ?: emptyList()
            if (currentPoints.size > tempFileFlushedCurrentSize) {
                for (i in tempFileFlushedCurrentSize until currentPoints.size) {
                    sb.append(GpxIO.formatGpxPoint(currentPoints[i]))
                }
                tempFileFlushedCurrentSize = currentPoints.size
            }

            if (!openedNewSegments && sb.isEmpty()) return

            if (!truncateTempFileClosingTags(f)) {
                fullRewrite()
                return
            }
            sb.append(GpxIO.TEMP_FILE_CLOSING_TAGS)
            FileOutputStream(f, /* append = */ true).use { out ->
                out.write(sb.toString().toByteArray(Charsets.UTF_8))
            }
        } catch (e: Exception) {
            Log.e(tag, "flush failed (append-only) — falling back to full rewrite", e)
            fullRewrite()
        }
    }

    /**
     * Phase 5: reloads points from the temp file into the segmented buffer
     * via the [setBuffer] callback. Each `<trkseg>` block becomes one
     * segment. The last `<trkseg>` becomes the current segment; all earlier
     * `<trkseg>` blocks become finalized segments.
     *
     * L30 fix (preserved): uses XmlPullParser instead of regex for
     * robustness against CDATA, comments, and attribute-order variations.
     *
     * L21 fix (preserved): points with missing or unparseable timestamps
     * are SKIPPED. If more than 10% of points have bad timestamps, the
     * reload is aborted entirely (buffer left empty) — better to start a
     * fresh segment than to mix garbage into the timeline.
     *
     * L26 fix (preserved): syncs the append-only state with what's now in
     * the file so future flushes truncate + append correctly.
     */
    fun reloadPointsIntoBuffer() {
        try {
            val f = getTempFile()
            if (!f.exists()) return
            val parseResult = f.inputStream().use { GpxIO.parseGpxSegments(it) }
            // L21: abort if too many points had bad timestamps.
            if (parseResult.totalPointCount > 0 &&
                parseResult.skippedPointCount.toDouble() / parseResult.totalPointCount >
                GpsRecorderService.RELOAD_BAD_TIMESTAMP_ABORT_FRACTION
            ) {
                Log.e(
                    tag,
                    "reloadPointsIntoBuffer: aborting — ${parseResult.skippedPointCount}/${parseResult.totalPointCount} " +
                        "points had unparseable timestamps (> ${GpsRecorderService.RELOAD_BAD_TIMESTAMP_ABORT_FRACTION * 100}%). " +
                        "Buffer left empty; recording will start a fresh segment."
                )
                setBuffer(emptyList(), 0)
                resetState()
                setAppendState(false, 0, 0)
                return
            }
            if (parseResult.skippedPointCount > 0) {
                Log.w(
                    tag,
                    "reloadPointsIntoBuffer: skipped ${parseResult.skippedPointCount}/${parseResult.totalPointCount} " +
                        "points with unparseable timestamps — continuing with the rest."
                )
            }
            val parsedSegments = parseResult.segments
            if (parsedSegments.isEmpty()) {
                Log.w(tag, "reloadPointsIntoBuffer: no <trkseg> blocks in temp file")
                setBuffer(emptyList(), 0)
                resetState()
                setAppendState(false, 0, 0)
                return
            }
            // Convert GpxIO.GpxTrkPt → GpsPoint (same fields) and pass to
            // the service via the setBuffer callback.
            val gpsSegments = parsedSegments.map { seg ->
                ArrayList<GpsPoint>(seg.points.size).apply {
                    for (p in seg.points) {
                        add(GpsPoint(p.lat, p.lon, p.ele, p.speed, p.accuracy, p.timeMs))
                    }
                }
            }
            val totalPoints = gpsSegments.sumOf { it.size }
            setBuffer(gpsSegments, totalPoints)
            // L26: sync the append-only state with what's now in the file.
            tempFileInitialized = true
            tempFileFlushedSegments = parsedSegments.size
            tempFileFlushedCurrentSize = parsedSegments.lastOrNull()?.points?.size ?: 0
            Log.i(
                tag,
                "Reloaded $totalPoints points in ${parsedSegments.size} segments from temp file " +
                    "(skipped ${parseResult.skippedPointCount} bad-timestamp points)"
            )
        } catch (e: Exception) {
            Log.e(tag, "reloadPointsIntoBuffer failed", e)
        }
    }

    /** Deletes the temp file (called after a successful finalize). */
    fun deleteTempFile() {
        try { getTempFile().delete() } catch (_: Exception) {}
    }
}
