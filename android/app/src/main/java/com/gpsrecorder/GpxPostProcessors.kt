package com.gpsrecorder

import android.util.Log

/**
 * O7 / O24 — GPX post-processing algorithms extracted from
 * GpsRecorderService.kt.
 *
 * Contains the two finalize-time post-processors:
 *   1. [gaussianSmoothGpx] — Gaussian kernel smoother (±GAUSSIAN_HALF_WINDOW
 *      points, sigma = GAUSSIAN_SIGMA).
 *   2. [douglasPeuckerGpx] — iterative Douglas-Peucker simplification with
 *      cross-track perpendicular distance, explicit stack (no recursion).
 *
 * Both functions are pure string→string transforms; they don't touch service
 * state, SharedPreferences, or the filesystem. Logging is unconditional
 * (i/w/e only — no coordinates are emitted, per L33).
 *
 * The service delegates to these via `GpxPostProcessors.xxx(...)`. Extracted
 * to shrink GpsRecorderService.kt and make the post-processors unit-testable.
 */
object GpxPostProcessors {

    private const val TAG = "GpsRecorderService"

    // ---- Gaussian smoothing (post-processing) ----
    // Half-window size: each output point is a weighted average of the input
    // points within ±GAUSSIAN_HALF_WINDOW of it. ±5 points at 1 Hz covers a
    // ~11 s window, which is large enough to suppress single-fix glitches but
    // small enough not to round off real corners.
    const val GAUSSIAN_HALF_WINDOW = 5
    // Gaussian sigma (in points, not seconds) — controls how flat the kernel
    // is. With sigma=1.5 and a ±5 window, the weights drop to ~1% of the peak
    // at the edges, so the window edges contribute negligibly.
    const val GAUSSIAN_SIGMA = 1.5

    /**
     * Gaussian / kernel smoothing of the GPX track.
     *
     * Replaces each point's lat/lon (and altitude, if present) with a weighted
     * average of itself and its neighbours within ±[GAUSSIAN_HALF_WINDOW] points.
     * The weights follow a Gaussian kernel:
     *
     *     w(i, j) = exp( -0.5 * ((i - j) / GAUSSIAN_SIGMA)^2 )
     *
     * Timestamps, speed, and accuracy are preserved verbatim — only the spatial
     * coordinates are smoothed. The output has the SAME number of points as the
     * input (no interpolation, no dropping); only the lat/lon/ele values change.
     *
     * Effect: single-fix GPS glitches (which typically look like a spike 20–80 m
     * away from the true track) get pulled back towards their neighbours, since
     * the Gaussian-weighted average is dominated by the surrounding clean fixes.
     * Real corners are preserved reasonably well because the kernel is narrow
     * (±5 points at 1 Hz = ±5 s window).
     *
     * If parsing fails or no trkpt is found, the input is returned unchanged so
     * the user still gets a usable (raw) file rather than nothing.
     */
    fun gaussianSmoothGpx(rawGpx: String): String {
        // Phase 5: segment-isolated smoothing. We parse each <trkseg> block
        // separately, smooth the points within it independently, and re-emit
        // them inside their own <trkseg>. This prevents the Gaussian kernel
        // from "bleeding" coordinates across pauses / gaps — e.g. the first
        // point after a gap should NOT be averaged together with the last
        // point before the gap, because they belong to different parts of
        // the user's actual movement.
        //
        // L30 fix: parse via XmlPullParser instead of regex.
        val parseResult = GpxIO.parseGpxSegments(rawGpx)
        if (parseResult.segments.isEmpty()) {
            Log.w(TAG, "gaussianSmoothGpx: no <trkseg> found, returning raw input")
            return rawGpx
        }

        // 1. Pre-compute the Gaussian kernel weights for offsets -W..+W.
        //    w[k] = exp(-0.5 * (k / sigma)^2), k in [-W, W].
        val w = DoubleArray(2 * GAUSSIAN_HALF_WINDOW + 1) { kOff ->
            val k = (kOff - GAUSSIAN_HALF_WINDOW).toDouble()
            Math.exp(-0.5 * (k / GAUSSIAN_SIGMA) * (k / GAUSSIAN_SIGMA))
        }

        val origName = Regex("<name>([^<]*)</name>").find(rawGpx)?.groupValues?.get(1)
            ?: "GPS Recording"

        val sb = StringBuilder()
        sb.append(GpxIO.gpxHeader())
        sb.append("  <trk>\n")
        sb.append("    <name>").append(origName).append("</name>\n")

        var totalIn = 0
        var totalOut = 0
        for (seg in parseResult.segments) {
            val parsed = seg.points
            totalIn += parsed.size
            if (parsed.isEmpty()) {
                // Preserve empty <trkseg> blocks as-is so the segment
                // structure is preserved in the output.
                sb.append("    <trkseg>\n")
                sb.append("    </trkseg>\n")
                continue
            }

            // 2. Smooth each point within this segment independently.
            //
            // L2 fix: elevation MUST be weighted-averaged just like lat/lon.
            // The previous implementation tracked `nEle` (raw count of
            // non-null-elevation points in the window) and divided by it,
            // which produced `sumEleVal / nEle` — a value roughly
            // `sumW / nEle`-times too small (for a symmetric ±5 kernel
            // with sumW ≈ 2.0, every smoothed elevation came out at
            // ~40% of its true value). GPX viewers that plot elevation
            // showed a track sitting far below its real altitude.
            //
            // We now track `sumWEle` (sum of the kernel weights actually
            // used for elevation points) and divide by it. If no
            // elevation points fall in the window, the output has no
            // <ele> tag (preserving whatever the input had — typically
            // nothing, which is correct).
            val smoothed = ArrayList<GpxIO.GpxTrkPt>(parsed.size)
            for (i in parsed.indices) {
                var sumW = 0.0
                var sumLat = 0.0
                var sumLon = 0.0
                var sumEleVal = 0.0
                var sumWEle = 0.0
                for (kOff in 0 until w.size) {
                    val j = i + (kOff - GAUSSIAN_HALF_WINDOW)
                    if (j < 0 || j >= parsed.size) continue
                    val weight = w[kOff]
                    sumW += weight
                    sumLat += parsed[j].lat * weight
                    sumLon += parsed[j].lon * weight
                    val e = parsed[j].ele
                    if (e != null) {
                        sumEleVal += e * weight
                        sumWEle += weight
                    }
                }
                val newLat = if (sumW > 0.0) sumLat / sumW else parsed[i].lat
                val newLon = if (sumW > 0.0) sumLon / sumW else parsed[i].lon
                val newEle = if (sumWEle > 0.0) sumEleVal / sumWEle else null
                smoothed.add(
                    GpxIO.GpxTrkPt(
                        lat = newLat,
                        lon = newLon,
                        ele = newEle,
                        speed = parsed[i].speed,
                        accuracy = parsed[i].accuracy,
                        timeMs = parsed[i].timeMs,
                        interpolated = false
                    )
                )
            }
            totalOut += smoothed.size

            // 3. Re-emit the smoothed points inside their own <trkseg>.
            sb.append("    <trkseg>\n")
            for (p in smoothed) {
                sb.append(GpxIO.formatGpxPointWithInterpolated(p))
            }
            sb.append("    </trkseg>\n")
        }
        sb.append("  </trk>\n")
        sb.append("</gpx>\n")
        Log.i(
            TAG,
            "gaussianSmoothGpx: segments=${parseResult.segments.size} points in=$totalIn out=$totalOut" +
                " half-window=$GAUSSIAN_HALF_WINDOW sigma=$GAUSSIAN_SIGMA"
        )
        return sb.toString()
    }

    /**
     * Douglas-Peucker simplification of the GPX track.
     *
     * For each `<trkseg>`, applies the iterative Douglas-Peucker algorithm with
     * tolerance [epsilonM] meters: keeps the segment's first and last points
     * unconditionally, then recursively keeps the point of maximum
     * perpendicular distance from the line connecting the segment's current
     * endpoints — if that max distance exceeds epsilon, split there and
     * recurse on both halves; otherwise drop all intermediate points.
     *
     * Perpendicular distance is computed as the great-circle cross-track
     * distance (correct at any latitude, not just near the equator). The
     * algorithm is implemented iteratively with an explicit stack to avoid
     * stack overflow on long tracks (a 3-hour walk at 1 Hz = ~10 800 points,
     * which would blow the JVM default stack at recursion depth ~10 800).
     *
     * Timestamps, speed, accuracy, and elevation of the kept points are
     * preserved verbatim. The output has fewer (or equal) points than the
     * input — only the spatial density is reduced.
     *
     * Segments with < 3 points are returned unchanged (nothing to simplify).
     * Empty `<trkseg>` blocks are preserved as-is so the segment structure of
     * the input is mirrored in the output.
     *
     * If parsing fails or no `<trkseg>` is found, the input is returned
     * unchanged so the user still gets a usable (raw / pre-DP) file.
     */
    fun douglasPeuckerGpx(rawGpx: String, epsilonM: Double): String {
        // L30 fix: parse via XmlPullParser instead of regex.
        val parseResult = GpxIO.parseGpxSegments(rawGpx)
        if (parseResult.segments.isEmpty()) {
            Log.w(TAG, "douglasPeuckerGpx: no <trkseg> found, returning raw input")
            return rawGpx
        }

        val origName = Regex("<name>([^<]*)</name>").find(rawGpx)?.groupValues?.get(1)
            ?: "GPS Recording"

        val sb = StringBuilder()
        sb.append(GpxIO.gpxHeader())
        sb.append("  <trk>\n")
        sb.append("    <name>").append(origName).append("</name>\n")

        var totalIn = 0
        var totalOut = 0
        for (seg in parseResult.segments) {
            val parsed = seg.points
            totalIn += parsed.size
            if (parsed.isEmpty()) {
                // Preserve empty <trkseg> blocks as-is so the segment
                // structure is preserved in the output.
                sb.append("    <trkseg>\n")
                sb.append("    </trkseg>\n")
                continue
            }

            val kept = if (parsed.size < 3 || epsilonM <= 0.0) {
                // Nothing to simplify: keep all points verbatim.
                parsed
            } else {
                douglasPeuckerSimplify(parsed, epsilonM)
            }
            totalOut += kept.size

            sb.append("    <trkseg>\n")
            for (p in kept) {
                sb.append(GpxIO.formatGpxPointWithInterpolated(p))
            }
            sb.append("    </trkseg>\n")
        }
        sb.append("  </trk>\n")
        sb.append("</gpx>\n")
        Log.i(
            TAG,
            "douglasPeuckerGpx: segments=${parseResult.segments.size} points in=$totalIn out=$totalOut" +
                " epsilon=${epsilonM}m"
        )
        return sb.toString()
    }

    /**
     * Iterative Douglas-Peucker. Returns the subset of [points] that survives
     * simplification with tolerance [epsilonM] meters. The first and last
     * points are always kept. Intermediate points are kept iff their
     * perpendicular (cross-track) distance from the line connecting the
     * current endpoints exceeds epsilon, in which case the segment is split
     * there and each half is processed independently.
     *
     * Uses an explicit ArrayDeque as the stack so we don't blow the JVM call
     * stack on long tracks.
     */
    fun douglasPeuckerSimplify(
        points: List<GpxIO.GpxTrkPt>,
        epsilonM: Double
    ): List<GpxIO.GpxTrkPt> {
        val n = points.size
        if (n < 3) return points
        val keep = BooleanArray(n) { false }
        keep[0] = true
        keep[n - 1] = true
        val stack = ArrayDeque<Pair<Int, Int>>()
        stack.addLast(0 to n - 1)
        while (stack.isNotEmpty()) {
            val (start, end) = stack.removeLast()
            if (end - start < 2) continue
            val a = points[start]
            val b = points[end]
            var maxDist = -1.0
            var maxIdx = -1
            for (i in start + 1 until end) {
                val d = TrackMath.crossTrackDistanceM(points[i].lat, points[i].lon, a.lat, a.lon, b.lat, b.lon)
                if (d > maxDist) {
                    maxDist = d
                    maxIdx = i
                }
            }
            if (maxIdx >= 0 && maxDist > epsilonM) {
                keep[maxIdx] = true
                stack.addLast(start to maxIdx)
                stack.addLast(maxIdx to end)
            }
        }
        val out = ArrayList<GpxIO.GpxTrkPt>(n)
        for (i in 0 until n) {
            if (keep[i]) out.add(points[i])
        }
        return out
    }
}
