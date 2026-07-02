package com.gpsrecorder

import android.content.Context
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext

/**
 * Settings getter/setter bridge extracted from `GpsRecorderModule`
 * (Task K8).
 *
 * Owns the 22 @ReactMethod-annotated setters/getters (11 toggle pairs)
 * that persist user-facing settings in the SEPARATE
 * `gps_recorder_settings` SharedPreferences file (so they survive the
 * per-recording state clear in `GpsRecorderService.stopRecording()`).
 *
 *   1. post_process_enabled               (default false)
 *   2. gaussian_smoothing_enabled         (default false)
 *   3. radial_distance_filter_enabled     (default false)
 *      radial_distance_threshold_m        (default 5, clamp [0, 1000])
 *   4. time_sampling_enabled              (default false)
 *      time_sampling_n                    (default 5, clamp [1, 60])
 *   5. douglas_peucker_enabled            (default false)
 *      douglas_peucker_epsilon_m          (default 5.0, clamp [0.0, 500.0])
 *   6. auto_pause_enabled                 (default false)
 *   7. gap_detection_enabled              (default TRUE — preserves
 *      the behaviour shipped in the previous APK)
 *   8. show_moving_time_enabled           (default false — legacy
 *      wall-clock display)
 *
 * The `GpsRecorderModule` keeps the @ReactMethod-annotated wrappers
 * (because that's how RN discovers the JS-facing API) and delegates
 * each one to this class.
 *
 * All settings are persisted via `getSharedPreferences(
 * "gps_recorder_settings", MODE_PRIVATE)`. The keys + defaults are
 * also mirrored in `GpsRecorderSettings` (the constants object the
 * service reads from); we keep the literal strings here to avoid
 * changing the on-disk format.
 */
class SettingsBridge(private val reactContext: ReactApplicationContext) {

    private fun settingsPrefs() =
        reactContext.getSharedPreferences("gps_recorder_settings", Context.MODE_PRIVATE)

    // ---- Post-processing setting ----
    //
    // Persisted in a SEPARATE SharedPreferences file ("gps_recorder_settings") so it
    // survives the recording-state clear that happens on stopRecording(). When enabled,
    // GpsRecorderService.finalizeGpxFile() will, after writing the raw GPX file, read
    // it back, apply the post-processing algorithm (sort/dedupe/jump-sweep/interpolate),
    // and overwrite the file with the processed content. When disabled, only raw data
    // is written (the original behavior).

    fun setPostProcessEnabled(enabled: Boolean, promise: Promise) {
        try {
            settingsPrefs().edit().putBoolean("post_process_enabled", enabled).apply()
            Log.i(TAG, "Post-process enabled = $enabled")
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setPostProcessEnabled error", e)
        }
    }

    fun getPostProcessEnabled(promise: Promise) {
        try {
            promise.resolve(settingsPrefs().getBoolean("post_process_enabled", false))
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getPostProcessEnabled error", e)
        }
    }

    // ---- Gaussian-smoothing setting ----
    //
    // Persisted in the same SEPARATE SharedPreferences file ("gps_recorder_settings")
    // as post_process_enabled, so it survives the per-recording state clear. When
    // enabled, GpsRecorderService.finalizeGpxFile() will — after writing the raw /
    // on-the-fly-filtered GPX file — read it back, apply a Gaussian kernel smoother
    // to the lat/lon coordinates, and overwrite the file with the smoothed track.

    fun setGaussianSmoothingEnabled(enabled: Boolean, promise: Promise) {
        try {
            settingsPrefs().edit().putBoolean("gaussian_smoothing_enabled", enabled).apply()
            Log.i(TAG, "Gaussian smoothing enabled = $enabled")
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setGaussianSmoothingEnabled error", e)
        }
    }

    fun getGaussianSmoothingEnabled(promise: Promise) {
        try {
            promise.resolve(settingsPrefs().getBoolean("gaussian_smoothing_enabled", false))
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getGaussianSmoothingEnabled error", e)
        }
    }

    // ---- Radial-distance on-the-fly filter ----
    //
    // Independent toggle (does NOT require post_process_enabled). When on,
    // GpsRecorderService.onLocationChanged drops every fix whose great-circle
    // distance to the LAST KEPT point is < radial_distance_threshold_m meters.
    // The first fix of each segment is always kept (no previous reference).
    //
    // Persisted in the same "gps_recorder_settings" prefs file so it survives
    // the per-recording state clear. Default off, default threshold 5 m.

    fun setRadialDistanceFilterEnabled(enabled: Boolean, promise: Promise) {
        try {
            settingsPrefs().edit().putBoolean("radial_distance_filter_enabled", enabled).apply()
            Log.i(TAG, "Radial distance filter enabled = $enabled")
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setRadialDistanceFilterEnabled error", e)
        }
    }

    fun getRadialDistanceFilterEnabled(promise: Promise) {
        try {
            promise.resolve(settingsPrefs().getBoolean("radial_distance_filter_enabled", false))
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getRadialDistanceFilterEnabled error", e)
        }
    }

    fun setRadialDistanceThresholdM(thresholdM: Int, promise: Promise) {
        try {
            // Clamp to [0, 1000] — 0 disables (everything is "too close"),
            // 1000 m is an absurd upper bound for a walk/run filter.
            val clamped = thresholdM.coerceIn(0, 1000)
            settingsPrefs().edit().putInt("radial_distance_threshold_m", clamped).apply()
            Log.i(TAG, "Radial distance threshold = $clamped m")
            promise.resolve(clamped)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setRadialDistanceThresholdM error", e)
        }
    }

    fun getRadialDistanceThresholdM(promise: Promise) {
        try {
            promise.resolve(settingsPrefs().getInt("radial_distance_threshold_m", 5))
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getRadialDistanceThresholdM error", e)
        }
    }

    // ---- Time-sampling on-the-fly filter ----
    //
    // Independent toggle. When on, GpsRecorderService.onLocationChanged keeps
    // every N-th fix and drops the rest. Useful for shrinking file size on
    // long recordings where 1 Hz is overkill. The counter resets at the start
    // of each recording (and is not persisted across service restarts — a
    // restart simply begins a fresh sampling window).
    //
    // Persisted in the same "gps_recorder_settings" prefs file. Default off,
    // default N = 5 (i.e. keep one fix every ~5 s at 1 Hz).

    fun setTimeSamplingEnabled(enabled: Boolean, promise: Promise) {
        try {
            settingsPrefs().edit().putBoolean("time_sampling_enabled", enabled).apply()
            Log.i(TAG, "Time sampling enabled = $enabled")
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setTimeSamplingEnabled error", e)
        }
    }

    fun getTimeSamplingEnabled(promise: Promise) {
        try {
            promise.resolve(settingsPrefs().getBoolean("time_sampling_enabled", false))
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getTimeSamplingEnabled error", e)
        }
    }

    fun setTimeSamplingN(n: Int, promise: Promise) {
        try {
            // Clamp to [1, 60] — 1 means "keep every fix" (no-op), 60 means
            // keep one fix per minute at 1 Hz.
            val clamped = n.coerceIn(1, 60)
            settingsPrefs().edit().putInt("time_sampling_n", clamped).apply()
            Log.i(TAG, "Time sampling N = $clamped")
            promise.resolve(clamped)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setTimeSamplingN error", e)
        }
    }

    fun getTimeSamplingN(promise: Promise) {
        try {
            promise.resolve(settingsPrefs().getInt("time_sampling_n", 5))
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getTimeSamplingN error", e)
        }
    }

    // ---- Douglas-Peucker post-processing ----
    //
    // Independent toggle. When on, GpsRecorderService.finalizeGpxFile will —
    // AFTER writing the raw / on-the-fly-filtered GPX file (and AFTER Gaussian
    // smoothing, if that is also enabled) — read the file back, apply the
    // Douglas-Peucker algorithm to each <trkseg> independently with tolerance
    // `douglas_peucker_epsilon_m` meters, and overwrite the file with the
    // simplified track.
    //
    // The algorithm: recursively keep the point of maximum perpendicular
    // distance from the line connecting the segment's first and last points;
    // if that max distance exceeds epsilon, split there and recurse on both
    // halves; otherwise drop all intermediate points. Implemented iteratively
    // to avoid stack overflow on long tracks.
    //
    // Perpendicular distance is computed as the great-circle cross-track
    // distance (so it's correct at any latitude, not just near the equator).
    //
    // Persisted in the same "gps_recorder_settings" prefs file. Default off,
    // default epsilon 5.0 m. Epsilon is stored as a string (Double.toString)
    // because SharedPreferences has no putDouble; this matches how the
    // service already persists totalDistanceM.

    fun setDouglasPeuckerEnabled(enabled: Boolean, promise: Promise) {
        try {
            settingsPrefs().edit().putBoolean("douglas_peucker_enabled", enabled).apply()
            Log.i(TAG, "Douglas-Peucker enabled = $enabled")
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setDouglasPeuckerEnabled error", e)
        }
    }

    fun getDouglasPeuckerEnabled(promise: Promise) {
        try {
            promise.resolve(settingsPrefs().getBoolean("douglas_peucker_enabled", false))
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getDouglasPeuckerEnabled error", e)
        }
    }

    fun setDouglasPeuckerEpsilonM(epsilonM: Double, promise: Promise) {
        try {
            // Clamp to [0.0, 500.0] — 0 keeps only segment endpoints (extreme
            // simplification), 500 m is an absurd upper bound for walk/run.
            val clamped = epsilonM.coerceIn(0.0, 500.0)
            settingsPrefs().edit().putString("douglas_peucker_epsilon_m", clamped.toString()).apply()
            Log.i(TAG, "Douglas-Peucker epsilon = $clamped m")
            promise.resolve(clamped)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setDouglasPeuckerEpsilonM error", e)
        }
    }

    fun getDouglasPeuckerEpsilonM(promise: Promise) {
        try {
            val s = settingsPrefs().getString("douglas_peucker_epsilon_m", null)
            val v = s?.toDoubleOrNull() ?: 5.0
            promise.resolve(v)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getDouglasPeuckerEpsilonM error", e)
        }
    }

    // ---- Auto-pause setting (Phase 1) ----
    //
    // Persisted in the same SEPARATE SharedPreferences file ("gps_recorder_settings")
    // as post_process_enabled / gaussian_smoothing_enabled, so it survives the
    // per-recording state clear. When enabled, GpsRecorderService runs a stop-
    // detection algorithm (sliding 10 s window + speed < 0.35 m/s + max
    // displacement < 3.5 m) that auto-pauses recording while the user is
    // standing still, and auto-resumes when they start moving again.

    fun setAutoPauseEnabled(enabled: Boolean, promise: Promise) {
        try {
            settingsPrefs().edit().putBoolean("auto_pause_enabled", enabled).apply()
            Log.i(TAG, "Auto-pause enabled = $enabled")
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setAutoPauseEnabled error", e)
        }
    }

    fun getAutoPauseEnabled(promise: Promise) {
        try {
            promise.resolve(settingsPrefs().getBoolean("auto_pause_enabled", false))
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getAutoPauseEnabled error", e)
        }
    }

    // ---- Gap-detection setting (Phase 4 toggle) ----
    //
    // Persisted in the same SEPARATE SharedPreferences file
    // ("gps_recorder_settings") as the other toggles, so it survives the
    // per-recording state clear. When enabled (DEFAULT — preserves the
    // behaviour shipped in the previous APK), the gap watchdog in
    // GpsRecorderService.flushTick declares signalLost after
    // GAP_THRESHOLD_MS (15 s) without a fix, and the next arriving fix
    // triggers a segment split so the track has clean <trkseg> breaks at
    // signal outages. When disabled, gaps are NOT detected: the timer
    // keeps running across the outage, the next fix is appended to the
    // same segment, and the velocity gate will compare it against the
    // pre-gap point — the legacy pre-Phase-4 behaviour.

    fun setGapDetectionEnabled(enabled: Boolean, promise: Promise) {
        try {
            settingsPrefs().edit().putBoolean("gap_detection_enabled", enabled).apply()
            Log.i(TAG, "Gap detection enabled = $enabled")
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setGapDetectionEnabled error", e)
        }
    }

    fun getGapDetectionEnabled(promise: Promise) {
        try {
            // Default true: the previous APK always ran gap detection, so
            // existing users get the same behaviour after upgrading.
            promise.resolve(settingsPrefs().getBoolean("gap_detection_enabled", true))
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getGapDetectionEnabled error", e)
        }
    }

    // ---- Show-moving-time display toggle (CODE_REVIEW_TODO Task 4) ----
    //
    // Pure display preference: when ON, the JS UI shows movingMs (active
    // moving time, excludes auto-paused and signal-lost intervals) in the
    // top time display and computes avg pace from movingMs. When OFF, the
    // UI shows elapsedMs (wall-clock) — the legacy behaviour.
    //
    // The native side ALWAYS emits both elapsedMs and movingMs in every
    // duration / location / state event, so this toggle does not affect
    // what gets recorded — only what the UI chooses to display. It is
    // NOT locked while a recording is in progress (the user can toggle
    // it any time, including mid-recording).
    //
    // Persisted in the same "gps_recorder_settings" prefs file as the
    // other display / filter toggles so it survives the per-recording
    // state clear. Default false: existing users keep the legacy
    // wall-clock time display after upgrading.

    fun setShowMovingTimeEnabled(enabled: Boolean, promise: Promise) {
        try {
            settingsPrefs().edit().putBoolean("show_moving_time_enabled", enabled).apply()
            Log.i(TAG, "Show-moving-time enabled = $enabled")
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "setShowMovingTimeEnabled error", e)
        }
    }

    fun getShowMovingTimeEnabled(promise: Promise) {
        try {
            promise.resolve(settingsPrefs().getBoolean("show_moving_time_enabled", false))
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "getShowMovingTimeEnabled error", e)
        }
    }

    private companion object {
        private const val TAG = "SettingsBridge"
    }
}
