package com.gpsrecorder

/**
 * A single GPS fix as recorded by [GpsRecorderService].
 *
 * This is the in-memory buffer representation used by the segmented track
 * buffer (`trackSegments` / `currentSegment`). The post-processing pipeline
 * uses the closely-related [GpxTrkPt] (which adds an `interpolated` flag);
 * the two are converted back and forth in [GpxIO] when reading from / writing
 * to GPX documents.
 *
 * Extracted from GpsRecorderService.kt as part of the refactor (see O7/O24).
 */
data class GpsPoint(
    val lat: Double,
    val lon: Double,
    val alt: Double?,
    val speed: Float?,
    val accuracy: Float?,
    val timeMs: Long
)
