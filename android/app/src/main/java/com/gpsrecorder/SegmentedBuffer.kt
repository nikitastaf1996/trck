package com.gpsrecorder

/**
 * K6 — Segmented track buffer extracted from GpsRecorderService.kt.
 *
 * Pure data-management class that owns the multi-segment in-memory point
 * buffer used by the recorder:
 *   - [trackSegments] — finalized segments (each becomes one `<trkseg>` in
 *     the output GPX).
 *   - [currentSegment] — the currently-active segment that new accepted
 *     fixes are appended to.
 *   - [pointBufferLock] — monitor lock guarding the two collections above.
 *
 * New segments are created on auto-pause transitions and gap-recovery
 * events (via [createNewSegment]) so the final track has clean `<trkseg>`
 * breaks at those points (no straight-line "stitches" across pauses /
 * gaps).
 *
 * The class deliberately holds NO reference to [GpsRecorderService]: every
 * method is pure buffer manipulation. The service and other helpers
 * (StateRepository, TempFileBuffer) access the buffer either through the
 * methods below or by synchronizing on [pointBufferLock] and reading the
 * fields directly (recovery / reload paths).
 *
 * Invariants preserved verbatim from the inline implementation:
 *   - Phase 2: [createNewSegment] is a no-op when [currentSegment] is
 *     empty (so auto-pause transitions that fire before any fix arrived
 *     do not produce empty `<trkseg>` blocks in the GPX).
 *   - Phase 2: [appendPointToCurrentSegment] atomically updates the
 *     service-side `pointCount` snapshot (returned to the caller, which
 *     assigns it to `service.pointCount`) UNDER the buffer lock so the
 *     count and the buffer never diverge.
 *   - Phase 2: [segmentsSnapshot] returns deep copies so callers can
 *     iterate the result without holding the lock.
 */
class SegmentedBuffer {

    // ---- Segmented track buffer (Phase 2) ----
    // Replaces the flat pointBuffer. Each segment corresponds to one
    // <trkseg> in the output GPX. New segments are created on auto-pause
    // transitions and gap-detection events so the final track has clean
    // breaks at those points (no straight-line "stitches" across pauses /
    // gaps). The currently-active segment is `currentSegment`; finalized
    // segments live in `trackSegments`.
    internal val trackSegments = ArrayList<ArrayList<GpsPoint>>()
    @Volatile internal var currentSegment = ArrayList<GpsPoint>()
    internal val pointBufferLock = Any()

    /**
     * Finalizes the current segment (if non-empty) and starts a new, empty
     * one. Called on auto-pause transitions and gap-recovery events so the
     * track has clean <trkseg> breaks at those points (no straight-line
     * "stitches" across pauses / gaps).
     *
     * Safe to call when currentSegment is already empty — it is a no-op in
     * that case.
     */
    fun createNewSegment() {
        synchronized(pointBufferLock) {
            if (currentSegment.isNotEmpty()) {
                trackSegments.add(currentSegment)
                currentSegment = ArrayList()
            }
        }
    }

    /**
     * Returns the total number of points across all finalized segments plus
     * the currently-active segment. This is the value reported to JS as
     * `pointCount`.
     */
    fun totalPointCount(): Int = synchronized(pointBufferLock) {
        var n = currentSegment.size
        for (seg in trackSegments) n += seg.size
        n
    }

    /**
     * Returns a snapshot of all segments (finalized + current) for serialization.
     * Each inner list is one <trkseg>.
     */
    fun segmentsSnapshot(): List<List<GpsPoint>> = synchronized(pointBufferLock) {
        val out = ArrayList<List<GpsPoint>>(trackSegments.size + 1)
        for (seg in trackSegments) out.add(ArrayList(seg))
        out.add(ArrayList(currentSegment))
        out
    }

    /**
     * Adds a point to the currently-active segment and returns the new
     * total point count (across finalized + current segments) so the
     * caller can refresh its `pointCount` snapshot atomically.
     *
     * Caller must have already validated the point (accuracy / velocity gates,
     * auto-pause / gap detection, etc.).
     */
    fun appendPointToCurrentSegment(pt: GpsPoint): Int {
        synchronized(pointBufferLock) {
            currentSegment.add(pt)
            return currentSegment.size + trackSegments.sumOf { it.size }
        }
    }

    /**
     * Clears both [trackSegments] and [currentSegment]. Called on a fresh
     * recording start (user pressed START) so leftover state from a
     * previous session cannot leak into the new one.
     */
    fun reset() {
        synchronized(pointBufferLock) {
            trackSegments.clear()
            currentSegment = ArrayList()
        }
    }
}
