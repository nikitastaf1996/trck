package com.gpsrecorder

import android.content.Context

/**
 * O7 / O24 — User-facing settings access extracted from GpsRecorderService.kt.
 *
 * The service has 5 independent user-facing toggles + 3 numeric parameters,
 * all persisted in the **`gps_recorder_settings`** SharedPreferences file
 * (NOT `gps_recorder_state`, which is per-recording live state and is
 * cleared in stopRecording()).
 *
 *   1. `post_process_enabled`           — on-the-fly accuracy/velocity gate
 *   2. `gaussian_smoothing_enabled`     — finalize-time Gaussian smoother
 *   3. `radial_distance_filter_enabled` + `radial_distance_threshold_m`
 *   4. `time_sampling_enabled`          + `time_sampling_n`
 *   5. `douglas_peucker_enabled`        + `douglas_peucker_epsilon_m`
 *   6. `auto_pause_enabled`             — stop-detection auto-pause
 *   7. `gap_detection_enabled`          — signal-loss gap detection
 *
 * This object is the single source of truth for the prefs file name and
 * all settings keys / defaults. It eliminates 11 previously-duplicated
 * `"gps_recorder_settings"` string literals and ~40 lines of boilerplate
 * `getSharedPreferences(...).getXxx(KEY, default)` calls.
 *
 * The service delegates via `GpsRecorderSettings.isXxx(context)` /
 * `GpsRecorderSettings.getXxx(context)`. The setters live in
 * `GpsRecorderModule` (they are called from JS and additionally emit
 * state-sync events).
 */
object GpsRecorderSettings {

    const val SETTINGS_PREFS_NAME = "gps_recorder_settings"

    // ---- Toggle keys ----
    const val KEY_POST_PROCESS_ENABLED = "post_process_enabled"
    const val KEY_GAUSSIAN_SMOOTHING_ENABLED = "gaussian_smoothing_enabled"
    const val KEY_AUTO_PAUSE_ENABLED = "auto_pause_enabled"
    const val KEY_GAP_DETECTION_ENABLED = "gap_detection_enabled"
    const val KEY_SHOW_MOVING_TIME_ENABLED = "show_moving_time_enabled"
    const val KEY_RADIAL_DISTANCE_FILTER_ENABLED = "radial_distance_filter_enabled"
    const val KEY_TIME_SAMPLING_ENABLED = "time_sampling_enabled"
    const val KEY_DOUGLAS_PEUCKER_ENABLED = "douglas_peucker_enabled"

    // ---- Numeric parameter keys ----
    const val KEY_RADIAL_DISTANCE_THRESHOLD_M = "radial_distance_threshold_m"
    const val KEY_TIME_SAMPLING_N = "time_sampling_n"
    const val KEY_DOUGLAS_PEUCKER_EPSILON_M = "douglas_peucker_epsilon_m"

    // ---- Defaults ----
    const val DEFAULT_RADIAL_DISTANCE_THRESHOLD_M = 5
    const val DEFAULT_TIME_SAMPLING_N = 5
    const val DEFAULT_DOUGLAS_PEUCKER_EPSILON_M = 5.0

    private fun prefs(context: Context) =
        context.getSharedPreferences(SETTINGS_PREFS_NAME, Context.MODE_PRIVATE)

    // ------------------------------------------------------------------
    // On-the-fly filter toggles
    // ------------------------------------------------------------------

    /**
     * Reads the post-process setting (on-the-fly accuracy/velocity gate).
     * When enabled, `onLocationChanged` applies both an accuracy gate
     * (drop fixes with horizontal accuracy worse than
     * `LocationChangedHandler.ACCURACY_THRESHOLD_M`) and a velocity gate
     * (drop fixes implying instantaneous velocity >
     * `LocationChangedHandler.MAX_VELOCITY_MPS`) BEFORE appending the point
     * to the buffer. When disabled, every fix is appended raw and the
     * distance accumulator alone applies the same gates.
     */
    fun isPostProcessEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_POST_PROCESS_ENABLED, false)

    /**
     * Reads the Gaussian-smoothing setting. When enabled, finalizeGpxFile()
     * will (after writing the raw / on-the-fly-filtered GPX file) read it
     * back, apply a Gaussian kernel smoother to the lat/lon coordinates,
     * and overwrite the file with the smoothed track.
     */
    fun isGaussianSmoothingEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_GAUSSIAN_SMOOTHING_ENABLED, false)

    /**
     * Reads the radial-distance on-the-fly filter setting. When enabled,
     * `onLocationChanged` drops every fix whose great-circle distance to
     * the LAST KEPT point is < [getRadialDistanceThresholdM]. The first
     * fix of each segment (prevLat == null) is always kept.
     */
    fun isRadialDistanceFilterEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_RADIAL_DISTANCE_FILTER_ENABLED, false)

    fun getRadialDistanceThresholdM(context: Context): Int =
        prefs(context).getInt(KEY_RADIAL_DISTANCE_THRESHOLD_M, DEFAULT_RADIAL_DISTANCE_THRESHOLD_M)

    /**
     * Reads the time-sampling on-the-fly filter setting. When enabled,
     * `onLocationChanged` keeps every N-th fix (counter % N == 0) and drops
     * the rest. The very first fix of a recording is always kept so the
     * track has a starting point even if N > 1.
     */
    fun isTimeSamplingEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_TIME_SAMPLING_ENABLED, false)

    fun getTimeSamplingN(context: Context): Int =
        prefs(context).getInt(KEY_TIME_SAMPLING_N, DEFAULT_TIME_SAMPLING_N)

    /**
     * Reads the Douglas-Peucker post-processing setting. When enabled,
     * `finalizeGpxFile` — AFTER writing the raw / on-the-fly-filtered GPX
     * file AND after Gaussian smoothing (if that is also enabled) — reads
     * the file back, applies Douglas-Peucker to each `<trkseg>` independently,
     * and overwrites the file with the simplified track.
     */
    fun isDouglasPeuckerEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_DOUGLAS_PEUCKER_ENABLED, false)

    fun getDouglasPeuckerEpsilonM(context: Context): Double {
        val s = prefs(context).getString(KEY_DOUGLAS_PEUCKER_EPSILON_M, null)
        return s?.toDoubleOrNull() ?: DEFAULT_DOUGLAS_PEUCKER_EPSILON_M
    }

    // ------------------------------------------------------------------
    // Auto-pause / gap detection toggles
    // ------------------------------------------------------------------

    /**
     * Reads the auto-pause setting. The setting is written by
     * `GpsRecorderModule.setAutoPauseEnabled()` from JS. Stored apart from
     * `gps_recorder_state` so it survives the per-recording state clear in
     * `stopRecording()`.
     */
    fun isAutoPauseEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_AUTO_PAUSE_ENABLED, false)

    /**
     * Reads the gap-detection setting. When enabled (default), the gap
     * watchdog declares `signalLost` after `AutoPauseGapController.GAP_THRESHOLD_MS` without a
     * fix, and the next arriving fix triggers a segment split so the track
     * has clean `<trkseg>` breaks at signal outages. When disabled, gaps
     * are NOT detected: the timer keeps running across the outage, the next
     * fix is appended to the same segment, and the velocity gate will
     * compare it against the pre-gap point.
     */
    fun isGapDetectionEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_GAP_DETECTION_ENABLED, true)

    /**
     * Reads the show-moving-time setting (Task 4). When enabled, the UI
     * shows the moving time (frozen during auto-pause / gap) instead of
     * the wall-clock elapsed time. This is a display-only toggle and is
     * NOT locked while recording.
     */
    fun isShowMovingTimeEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_SHOW_MOVING_TIME_ENABLED, false)
}
