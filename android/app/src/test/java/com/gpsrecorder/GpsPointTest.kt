package com.gpsrecorder

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull

/**
 * Unit tests for [GpsPoint] — the in-memory GPS fix data class.
 *
 * Data classes get `equals` / `hashCode` / `copy` / `toString` for free,
 * so we test the contract:
 *
 *   - Two instances with identical fields are equal (and have the same
 *     hash code).
 *   - Two instances differing in any field are NOT equal.
 *   - copy() preserves all fields by default and overrides only the
 *     named ones.
 *   - Null fields (alt / speed / accuracy) are handled correctly.
 */
class GpsPointTest {

    @Test
    fun equals_returnsTrue_forTwoInstancesWithIdenticalFields() {
        val a = GpsPoint(lat = 55.0, lon = 37.0, alt = 100.0, speed = 3.0f, accuracy = 5.0f, timeMs = 1_000L)
        val b = GpsPoint(lat = 55.0, lon = 37.0, alt = 100.0, speed = 3.0f, accuracy = 5.0f, timeMs = 1_000L)
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
    }

    @Test
    fun equals_returnsFalse_whenLatDiffers() {
        val a = GpsPoint(55.0, 37.0, null, null, null, 1_000L)
        val b = GpsPoint(56.0, 37.0, null, null, null, 1_000L)
        assertNotEquals(a, b)
    }

    @Test
    fun equals_returnsFalse_whenLonDiffers() {
        val a = GpsPoint(55.0, 37.0, null, null, null, 1_000L)
        val b = GpsPoint(55.0, 38.0, null, null, null, 1_000L)
        assertNotEquals(a, b)
    }

    @Test
    fun equals_returnsFalse_whenTimeMsDiffers() {
        val a = GpsPoint(55.0, 37.0, null, null, null, 1_000L)
        val b = GpsPoint(55.0, 37.0, null, null, null, 2_000L)
        assertNotEquals(a, b)
    }

    @Test
    fun equals_returnsFalse_whenAltDiffersIncludingNullVsNonNull() {
        val a = GpsPoint(55.0, 37.0, alt = 100.0, null, null, 1_000L)
        val b = GpsPoint(55.0, 37.0, alt = null, null, null, 1_000L)
        val c = GpsPoint(55.0, 37.0, alt = 200.0, null, null, 1_000L)
        assertNotEquals(a, b)
        assertNotEquals(a, c)
    }

    @Test
    fun equals_returnsFalse_whenSpeedDiffersIncludingNullVsNonNull() {
        val a = GpsPoint(55.0, 37.0, null, speed = 3.0f, null, 1_000L)
        val b = GpsPoint(55.0, 37.0, null, speed = null, null, 1_000L)
        assertNotEquals(a, b)
    }

    @Test
    fun equals_returnsFalse_whenAccuracyDiffersIncludingNullVsNonNull() {
        val a = GpsPoint(55.0, 37.0, null, null, accuracy = 5.0f, 1_000L)
        val b = GpsPoint(55.0, 37.0, null, null, accuracy = null, 1_000L)
        assertNotEquals(a, b)
    }

    @Test
    fun copy_preservesAllFieldsWhenNoOverridesGiven() {
        val a = GpsPoint(55.0, 37.0, 100.0, 3.0f, 5.0f, 1_000L)
        val b = a.copy()
        assertEquals(a, b)
    }

    @Test
    fun copy_overridesOnlyTheNamedFields() {
        val a = GpsPoint(55.0, 37.0, 100.0, 3.0f, 5.0f, 1_000L)
        val b = a.copy(timeMs = 2_000L)
        // timeMs changed.
        assertEquals(2_000L, b.timeMs)
        // Everything else preserved.
        assertEquals(a.lat, b.lat, 0.0)
        assertEquals(a.lon, b.lon, 0.0)
        assertEquals(a.alt, b.alt)
        assertEquals(a.speed, b.speed)
        assertEquals(a.accuracy, b.accuracy)
    }

    @Test
    fun toString_includesAllFieldNamesAndValues() {
        val p = GpsPoint(55.0, 37.0, 100.0, 3.0f, 5.0f, 1_000L)
        val s = p.toString()
        // The auto-generated toString() format is "GpsPoint(lat=X, lon=Y, ...)".
        assertTrue(s.contains("GpsPoint"))
        assertTrue(s.contains("lat=55.0"))
        assertTrue(s.contains("lon=37.0"))
        assertTrue(s.contains("alt=100.0"))
        assertTrue(s.contains("timeMs=1000"))
    }

    @Test
    fun toString_handlesNullFields() {
        val p = GpsPoint(55.0, 37.0, null, null, null, 1_000L)
        val s = p.toString()
        assertTrue(s.contains("alt=null"))
        assertTrue(s.contains("speed=null"))
        assertTrue(s.contains("accuracy=null"))
    }

    @Test
    fun canConstructWithAllNullableFieldsNull() {
        val p = GpsPoint(55.0, 37.0, null, null, null, 0L)
        assertNull(p.alt)
        assertNull(p.speed)
        assertNull(p.accuracy)
    }

    @Test
    fun canConstructWithNegativeLatLon() {
        // Southern hemisphere + western longitude.
        val p = GpsPoint(-33.86, 151.20, null, null, null, 0L)
        assertEquals(-33.86, p.lat, 0.0001)
        assertEquals(151.20, p.lon, 0.0001)
    }

    @Test
    fun canConstructWithNegativeAlt() {
        // Below sea level (e.g. Dead Sea at -430m).
        val p = GpsPoint(31.5, 35.5, -430.0, null, null, 0L)
        assertEquals(-430.0, p.alt!!, 0.0001)
    }
}

// Local helper — JUnit's assertTrue is in org.junit.Assert; here we add a
// kotlin-friendly overload so the assertions read cleanly.
private fun assertTrue(message: String, condition: Boolean) {
    org.junit.Assert.assertTrue(message, condition)
}
