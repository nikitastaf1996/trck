package com.gpsrecorder

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse

/**
 * Unit tests for [SegmentedBuffer] — the multi-segment in-memory point buffer.
 *
 * [SegmentedBuffer] is a pure-JVM class with no Android dependencies
 * (it uses only `ArrayList`, `synchronized`, and the [GpsPoint] data
 * class). It's the cleanest target for unit testing because:
 *
 *   - No mocking required (no `Context`, no `SharedPreferences`).
 *   - Thread safety is via `synchronized(pointBufferLock)`, which we
 *     exercise implicitly via single-threaded test calls.
 *
 * Coverage:
 *   - Fresh buffer has 0 total points.
 *   - appendPointToCurrentSegment adds 1 point + returns the new count.
 *   - createNewSegment finalizes the current segment (when non-empty).
 *   - createNewSegment is a no-op when currentSegment is empty.
 *   - segmentsSnapshot returns deep copies (mutating the snapshot
 *     doesn't affect the buffer).
 *   - reset() clears both the finalized segments and currentSegment.
 *   - Multiple createNewSegment calls produce multiple <trkseg> blocks.
 */
class SegmentedBufferTest {

    private fun pt(timeMs: Long = 1_000L, lat: Double = 55.0, lon: Double = 37.0) =
        GpsPoint(lat = lat, lon = lon, alt = null, speed = null, accuracy = null, timeMs = timeMs)

    @Test
    fun freshBuffer_hasZeroTotalPoints() {
        val buf = SegmentedBuffer()
        assertEquals(0, buf.totalPointCount())
    }

    @Test
    fun freshBuffer_hasEmptySegmentsSnapshot() {
        val buf = SegmentedBuffer()
        val snap = buf.segmentsSnapshot()
        assertEquals(1, snap.size) // just the (empty) current segment
        assertEquals(0, snap[0].size)
    }

    @Test
    fun appendPointToCurrentSegment_addsOnePoint_andReturnsNewCount() {
        val buf = SegmentedBuffer()
        val n1 = buf.appendPointToCurrentSegment(pt())
        val n2 = buf.appendPointToCurrentSegment(pt(timeMs = 2_000L))
        assertEquals(1, n1)
        assertEquals(2, n2)
        assertEquals(2, buf.totalPointCount())
    }

    @Test
    fun createNewSegment_isNoOp_whenCurrentSegmentIsEmpty() {
        val buf = SegmentedBuffer()
        buf.createNewSegment() // no current points → no-op
        buf.createNewSegment() // still no-op
        assertEquals(0, buf.totalPointCount())
        // The segmentsSnapshot should still have just one (empty) segment.
        assertEquals(1, buf.segmentsSnapshot().size)
    }

    @Test
    fun createNewSegment_finalizesCurrentSegment_whenNonEmpty() {
        val buf = SegmentedBuffer()
        buf.appendPointToCurrentSegment(pt(timeMs = 1_000L))
        buf.appendPointToCurrentSegment(pt(timeMs = 2_000L))
        buf.createNewSegment()
        // Now: 1 finalized segment with 2 points, current is empty.
        val snap = buf.segmentsSnapshot()
        assertEquals(2, snap.size) // 1 finalized + 1 (new empty) current
        assertEquals(2, snap[0].size) // finalized segment has 2 points
        assertEquals(0, snap[1].size) // current is empty
        assertEquals(2, buf.totalPointCount())
    }

    @Test
    fun multipleCreateNewSegment_produceMultipleFinalizedSegments() {
        val buf = SegmentedBuffer()
        // Segment 1: 2 points.
        buf.appendPointToCurrentSegment(pt(timeMs = 1_000L))
        buf.appendPointToCurrentSegment(pt(timeMs = 2_000L))
        buf.createNewSegment()
        // Segment 2: 1 point.
        buf.appendPointToCurrentSegment(pt(timeMs = 3_000L))
        buf.createNewSegment()
        // Segment 3: 3 points.
        buf.appendPointToCurrentSegment(pt(timeMs = 4_000L))
        buf.appendPointToCurrentSegment(pt(timeMs = 5_000L))
        buf.appendPointToCurrentSegment(pt(timeMs = 6_000L))
        val snap = buf.segmentsSnapshot()
        // 3 finalized + 1 (non-empty) current.
        assertEquals(4, snap.size)
        assertEquals(2, snap[0].size)
        assertEquals(1, snap[1].size)
        assertEquals(3, snap[2].size)
        assertEquals(3, snap[3].size)
        // Total = 2 + 1 + 3 + 3 = 9.
        assertEquals(9, buf.totalPointCount())
    }

    @Test
    fun segmentsSnapshot_returnsDeepCopies_mutatingSnapshotDoesNotAffectBuffer() {
        val buf = SegmentedBuffer()
        buf.appendPointToCurrentSegment(pt(timeMs = 1_000L, lat = 55.0))
        val snap1 = buf.segmentsSnapshot()
        // Mutate the snapshot — the buffer should be unaffected.
        snap1[0].clear()
        val snap2 = buf.segmentsSnapshot()
        assertEquals(1, snap2[0].size)
        assertEquals(55.0, snap2[0][0].lat, 0.0001)
    }

    @Test
    fun reset_clearsBothFinalizedSegmentsAndCurrentSegment() {
        val buf = SegmentedBuffer()
        buf.appendPointToCurrentSegment(pt(timeMs = 1_000L))
        buf.createNewSegment()
        buf.appendPointToCurrentSegment(pt(timeMs = 2_000L))
        // Pre-reset: at least 1 finalized segment + 1 current.
        assertTrue(buf.totalPointCount() >= 2)
        buf.reset()
        assertEquals(0, buf.totalPointCount())
        val snap = buf.segmentsSnapshot()
        assertEquals(1, snap.size)
        assertEquals(0, snap[0].size)
    }

    @Test
    fun reset_clearsStaleStateFromPreviousSession() {
        // Verify that after reset(), the buffer behaves like a fresh one.
        val buf = SegmentedBuffer()
        buf.appendPointToCurrentSegment(pt(timeMs = 1_000L))
        buf.createNewSegment()
        buf.appendPointToCurrentSegment(pt(timeMs = 2_000L))
        buf.createNewSegment()
        buf.reset()
        // Now append to the reset buffer.
        buf.appendPointToCurrentSegment(pt(timeMs = 100_000L, lat = 60.0))
        val snap = buf.segmentsSnapshot()
        assertEquals(1, snap.size)
        assertEquals(1, snap[0].size)
        assertEquals(60.0, snap[0][0].lat, 0.0001)
        assertEquals(100_000L, snap[0][0].timeMs)
    }

    @Test
    fun appendPointToCurrentSegment_returnsMonotonicallyIncreasingCount() {
        val buf = SegmentedBuffer()
        val counts = (1..10).map { i ->
            buf.appendPointToCurrentSegment(pt(timeMs = i.toLong() * 1_000L))
        }
        // Counts should be 1, 2, 3, ..., 10.
        assertEquals((1..10).toList(), counts)
        assertEquals(10, buf.totalPointCount())
    }

    @Test
    fun createNewSegment_thenAppend_addsToNewEmptyCurrentSegment() {
        val buf = SegmentedBuffer()
        buf.appendPointToCurrentSegment(pt(timeMs = 1_000L, lat = 55.0))
        buf.createNewSegment()
        // After createNewSegment, current should be empty. The next
        // append should go to the NEW current segment, not the
        // finalized one.
        buf.appendPointToCurrentSegment(pt(timeMs = 2_000L, lat = 60.0))
        val snap = buf.segmentsSnapshot()
        // 1 finalized (with the first point) + 1 current (with the new point).
        assertEquals(2, snap.size)
        assertEquals(1, snap[0].size)
        assertEquals(55.0, snap[0][0].lat, 0.0001)
        assertEquals(1, snap[1].size)
        assertEquals(60.0, snap[1][0].lat, 0.0001)
    }

    @Test
    fun totalPointCount_includesBothFinalizedAndCurrent() {
        val buf = SegmentedBuffer()
        // 5 points in current.
        for (i in 1..5) buf.appendPointToCurrentSegment(pt(timeMs = i.toLong() * 1_000L))
        assertEquals(5, buf.totalPointCount())
        // Finalize the 5-point segment.
        buf.createNewSegment()
        assertEquals(5, buf.totalPointCount()) // unchanged after finalize
        // Add 3 more points to current.
        for (i in 6..8) buf.appendPointToCurrentSegment(pt(timeMs = i.toLong() * 1_000L))
        assertEquals(8, buf.totalPointCount()) // 5 finalized + 3 current
    }

    @Test
    fun segmentsSnapshot_isSafeToCallWithoutAffectingSubsequentAppends() {
        val buf = SegmentedBuffer()
        buf.appendPointToCurrentSegment(pt(timeMs = 1_000L))
        val snap1 = buf.segmentsSnapshot()
        buf.appendPointToCurrentSegment(pt(timeMs = 2_000L))
        val snap2 = buf.segmentsSnapshot()
        // snap1 was a snapshot at time T1 (1 point); snap2 is at T2 (2 points).
        assertEquals(1, snap1[0].size)
        assertEquals(2, snap2[0].size)
        // The buffer's actual state matches the latest snapshot.
        assertEquals(2, buf.totalPointCount())
    }
}
