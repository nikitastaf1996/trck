package com.gpsrecorder

import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.Date

/**
 * O7 / O24 (round 2) — GPX file save pipeline extracted from
 * GpsRecorderService.kt.
 *
 * Encapsulates:
 *   - [finalizeGpxFile] — orchestrates serialize → save (MediaStore or
 *     legacy) → post-processing (Gaussian then Douglas-Peucker) → temp-
 *     file cleanup.
 *   - [saveViaMediaStore] — API 29+ save via MediaStore.Downloads.
 *   - [saveViaLegacyFile] — API < 29 save via direct File I/O.
 *   - [recomputeDistanceFromSavedGpx] — reads the saved GPX back and sums
 *     intra-segment haversine distances so the UI shows the true track
 *     length (post-smoothing) instead of the live-accumulated raw distance.
 *
 * L5 invariant preserved: empty buffers (or no segment with ≥2 points) are
 * NOT written to Downloads/trck/. The temp file IS deleted. Returns "" as
 * the empty sentinel — the caller (stopRecording) checks for this and skips
 * emitSaved().
 *
 * L13 invariant preserved: the MediaStore URI is persisted to
 * SharedPreferences under KEY_LAST_SAVED_URI so recomputeDistanceFromSavedGpx
 * can open the file via ContentResolver (instead of trying to resolve the
 * MediaStore-relative path through Environment, which on scoped storage
 * points to a different directory).
 *
 * L17 invariant preserved: segments with <2 points are dropped at
 * serialization time (in GpxIO.serializeSegmentsToGpx).
 *
 * Post-processing chain order preserved: Gaussian first (to suppress
 * single-fix glitches), then Douglas-Peucker (to decimate the smoothed
 * track). Either can be enabled on its own.
 */
class GpxFileSaver(
    private val service: GpsRecorderService,
    private val segmentsSnapshot: () -> List<List<GpsPoint>>,
    private val startTimeMs: () -> Long,
    private val deleteTempFile: () -> Unit,
) {

    private val tag: String get() = GpsRecorderService.TAG

    /**
     * Finalizes the GPX file: writes a complete GPX file (header + all
     * buffered points + footer) and saves it to the public Downloads folder.
     *
     * Returns the human-readable path/URI of the saved file, or "" if the
     * buffer was empty (L5 sentinel).
     */
    fun finalizeGpxFile(): String {
        val segments = segmentsSnapshot()
        val totalPoints = segments.sumOf { it.size }

        // L5 fix: do NOT write an empty GPX file to Downloads/trck/.
        val hasUsableSegment = segments.any { it.size >= 2 }
        if (totalPoints == 0 || !hasUsableSegment) {
            Log.i(tag, "Skipping finalize: empty buffer (totalPoints=$totalPoints)")
            deleteTempFile()
            return ""
        }

        val timestamp = GpxIO.FILENAME_SDF.format(Date(startTimeMs()))
        val fileName = "trck_$timestamp.gpx"

        val rawGpxContent = GpxIO.serializeSegmentsToGpx("GPS Recording $timestamp", segmentsSnapshot())
        val rawBytes = rawGpxContent.toByteArray(Charsets.UTF_8)

        val doGaussian = GpsRecorderSettings.isGaussianSmoothingEnabled(service)
        val doDouglasPeucker = GpsRecorderSettings.isDouglasPeuckerEnabled(service)
        val dpEpsilon = GpsRecorderSettings.getDouglasPeuckerEpsilonM(service)
        Log.i(
            tag,
            "finalizeGpxFile: segments=${segments.size} points=$totalPoints" +
                " onTheFlyFilter=${GpsRecorderSettings.isPostProcessEnabled(service)}" +
                " gaussianSmoothing=$doGaussian douglasPeucker=$doDouglasPeucker" +
                " dpEpsilon=${dpEpsilon}m" +
                " radialFilter=${GpsRecorderSettings.isRadialDistanceFilterEnabled(service)}" +
                " timeSampling=${GpsRecorderSettings.isTimeSamplingEnabled(service)}" +
                " autoPause=${GpsRecorderSettings.isAutoPauseEnabled(service)}"
        )

        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveViaMediaStore(
                    fileName, rawBytes,
                    gaussianSmooth = doGaussian,
                    douglasPeucker = doDouglasPeucker,
                    douglasPeuckerEpsilon = dpEpsilon
                )
            } else {
                saveViaLegacyFile(
                    fileName, rawBytes,
                    gaussianSmooth = doGaussian,
                    douglasPeucker = doDouglasPeucker,
                    douglasPeuckerEpsilon = dpEpsilon
                )
            }
        } catch (e: Exception) {
            Log.e(tag, "finalizeGpxFile failed; falling back to cache", e)
            try {
                val f = File(service.externalCacheDir ?: service.cacheDir, fileName)
                FileOutputStream(f).use { it.write(rawBytes) }
                "Cache fallback: ${f.absolutePath}"
            } catch (e2: Exception) {
                Log.e(tag, "Even cache fallback failed", e2)
                "Save failed: ${e2.message}"
            }
        } finally {
            deleteTempFile()
        }
    }

    private fun saveViaMediaStore(
        fileName: String,
        rawBytes: ByteArray,
        gaussianSmooth: Boolean = false,
        douglasPeucker: Boolean = false,
        douglasPeuckerEpsilon: Double = 5.0
    ): String {
        val resolver = service.contentResolver
        val values = android.content.ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            put(MediaStore.MediaColumns.MIME_TYPE, "application/gpx+xml")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/trck")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
        }
        val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Downloads.EXTERNAL_CONTENT_URI
        } else {
            MediaStore.Files.getContentUri("external")
        }
        val uri = resolver.insert(collection, values)
            ?: throw java.io.IOException("MediaStore insert returned null")
        try {
            resolver.openOutputStream(uri)?.use { out: OutputStream ->
                out.write(rawBytes)
                out.flush()
            } ?: throw java.io.IOException("Cannot open output stream for $uri")

            if (gaussianSmooth || douglasPeucker) {
                val rawText = resolver.openInputStream(uri)?.use { it.readBytes() }
                    ?.toString(Charsets.UTF_8) ?: ""
                var processed = rawText
                if (gaussianSmooth) {
                    processed = try {
                        GpxPostProcessors.gaussianSmoothGpx(processed)
                    } catch (e: Exception) {
                        Log.e(tag, "gaussianSmoothGpx failed; keeping pre-smoothing content", e)
                        processed
                    }
                }
                if (douglasPeucker) {
                    val before = GpxIO.countTrkpt(processed)
                    processed = try {
                        GpxPostProcessors.douglasPeuckerGpx(processed, douglasPeuckerEpsilon)
                    } catch (e: Exception) {
                        Log.e(tag, "douglasPeuckerGpx failed; keeping pre-DP content", e)
                        processed
                    }
                    val after = GpxIO.countTrkpt(processed)
                    Log.i(tag, "Douglas-Peucker applied (epsilon=${douglasPeuckerEpsilon}m): $before -> $after points")
                }
                val processedBytes = processed.toByteArray(Charsets.UTF_8)
                resolver.openOutputStream(uri, "wt")?.use { out: OutputStream ->
                    out.write(processedBytes)
                    out.flush()
                } ?: throw java.io.IOException("Cannot reopen output stream for $uri (post-process)")
                Log.i(tag, "Post-processed GPX written via MediaStore (${processedBytes.size} bytes)")
            }
        } finally {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val done = android.content.ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
                resolver.update(uri, done, null, null)
            }
        }
        // L13 fix: persist the MediaStore URI so recomputeDistanceFromSavedGpx
        // can open the file via ContentResolver.
        try {
            service.getSharedPreferences(StateRepository.PREFS_NAME, Context.MODE_PRIVATE).edit()
                .putString(StateRepository.KEY_LAST_SAVED_URI, uri.toString())
                .apply()
        } catch (e: Exception) {
            Log.w(tag, "Failed to persist last_saved_uri", e)
        }
        return "Downloads/trck/$fileName"
    }

    private fun saveViaLegacyFile(
        fileName: String,
        rawBytes: ByteArray,
        gaussianSmooth: Boolean = false,
        douglasPeucker: Boolean = false,
        douglasPeuckerEpsilon: Double = 5.0
    ): String {
        @Suppress("DEPRECATION")
        val downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val targetDir = File(downloadsDir, "trck").apply { if (!exists()) mkdirs() }
        val f = File(targetDir, fileName)
        FileOutputStream(f).use { it.write(rawBytes) }
        if (gaussianSmooth || douglasPeucker) {
            var processed = f.readText(Charsets.UTF_8)
            if (gaussianSmooth) {
                processed = try {
                    GpxPostProcessors.gaussianSmoothGpx(processed)
                } catch (e: Exception) {
                    Log.e(tag, "gaussianSmoothGpx failed; keeping pre-smoothing content", e)
                    processed
                }
            }
            if (douglasPeucker) {
                val before = GpxIO.countTrkpt(processed)
                processed = try {
                    GpxPostProcessors.douglasPeuckerGpx(processed, douglasPeuckerEpsilon)
                } catch (e: Exception) {
                    Log.e(tag, "douglasPeuckerGpx failed; keeping pre-DP content", e)
                    processed
                }
                val after = GpxIO.countTrkpt(processed)
                Log.i(tag, "Douglas-Peucker applied (epsilon=${douglasPeuckerEpsilon}m): $before -> $after points")
            }
            FileOutputStream(f).use { it.write(processed.toByteArray(Charsets.UTF_8)) }
            Log.i(tag, "Post-processed GPX written to ${f.absolutePath}")
        }
        return f.absolutePath
    }

    /**
     * Recomputes the final distance from the SAVED GPX file so the value
     * the user sees matches the track length Strava / other importers will
     * compute. This matters most when Gaussian smoothing is on: smoothing
     * pulls each point toward its neighbours, shortening the track by a
     * few percent vs. the raw live-accumulated haversine distance.
     *
     * L13 fix: prefers the persisted MediaStore URI on API 29+. Falls back
     * to legacy File path resolution on older APIs or cache-fallback paths.
     *
     * Returns -1.0 on any failure (L10 non-fatal) — JS interprets -1 as
     * "use live-accumulated distance".
     */
    fun recomputeDistanceFromSavedGpx(savedPath: String): Double {
        try {
            val savedUriStr = service.getSharedPreferences(StateRepository.PREFS_NAME, Context.MODE_PRIVATE)
                .getString(StateRepository.KEY_LAST_SAVED_URI, null)
            val parseResult: GpxIO.GpxParseResult = if (savedUriStr != null) {
                try {
                    val uri = android.net.Uri.parse(savedUriStr)
                    val parsed = service.contentResolver.openInputStream(uri)?.use { GpxIO.parseGpxSegments(it) }
                        ?: run {
                            Log.w(tag, "recomputeDistanceFromSavedGpx: openInputStream returned null for $savedUriStr")
                            return -1.0
                        }
                    parsed
                } catch (e: Exception) {
                    Log.w(tag, "recomputeDistanceFromSavedGpx: failed to open URI $savedUriStr", e)
                    return -1.0
                }
            } else {
                val file: File? = when {
                    savedPath.startsWith("Downloads/trck/") -> {
                        val downloads = Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_DOWNLOADS
                        )
                        File(downloads, "trck/${savedPath.removePrefix("Downloads/trck/")}")
                    }
                    savedPath.startsWith("/") -> File(savedPath)
                    savedPath.startsWith("Cache fallback: ") ->
                        File(savedPath.removePrefix("Cache fallback: "))
                    else -> null
                }
                if (file == null || !file.exists()) {
                    Log.w(tag, "recomputeDistanceFromSavedGpx: cannot resolve path '$savedPath'")
                    return -1.0
                }
                file.inputStream().use { GpxIO.parseGpxSegments(it) }
            }
            // Sum intra-segment distances. Inter-segment jumps are NOT counted.
            var total = 0.0
            var parsed = 0
            for (seg in parseResult.segments) {
                var prevLat: Double? = null
                var prevLon: Double? = null
                for (p in seg.points) {
                    parsed++
                    val pLat = prevLat
                    val pLon = prevLon
                    if (pLat != null && pLon != null) {
                        total += TrackMath.haversineMeters(pLat, pLon, p.lat, p.lon)
                    }
                    prevLat = p.lat
                    prevLon = p.lon
                }
            }
            Log.i(tag, "recomputeDistanceFromSavedGpx: parsed=$parsed total=${total}m from $savedPath (uri=${savedUriStr != null})")
            return total
        } catch (e: Exception) {
            Log.w(tag, "recomputeDistanceFromSavedGpx failed for '$savedPath'", e)
            GpsEventEmitter.emitError(
                "Could not recompute distance from saved GPX file; showing live distance instead.",
                fatal = false
            )
            return -1.0
        }
    }
}
