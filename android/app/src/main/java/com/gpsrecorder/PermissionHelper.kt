package com.gpsrecorder

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext

/**
 * Permission + battery-optimization helper extracted from
 * `GpsRecorderModule` (Task K8).
 *
 * Owns the L9 / L23 pending-promise patterns:
 *
 *   - `pendingPermissionsPromise`     — resolved inside MainActivity's
 *     ActivityResultContracts callback (via
 *     `setPermissionResultCallback`) so the JS caller's `await` resolves
 *     ONLY after the user actually responds to the system dialog.
 *
 *   - `pendingBatteryPromise`         — same pattern for
 *     `requestIgnoreBatteryOptimizations`, resolved inside
 *     MainActivity's `setBatteryResultCallback`.
 *
 * The four JS-facing methods (`requestPermissions`, `hasPermissions`,
 * `requestIgnoreBatteryOptimizations`, `openAppSettings`) are delegated
 * to from `GpsRecorderModule`'s @ReactMethod-annotated wrappers.
 * `teardown()` is called from `GpsRecorderModule.onCatalystInstanceDestroy()`
 * to resolve any pending promise with `false` (so JS doesn't hang waiting
 * for a callback that will never fire) and clear the activity-side
 * callbacks.
 *
 * `hasFineLocation()` / `hasNotificationPermission()` / `hasAllPermissions()`
 * are exposed as public helpers because `GpsRecorderModule.start()` and
 * `GnssMonitor.startGnssMonitor()` both gate on `hasFineLocation()`.
 */
class PermissionHelper(private val reactContext: ReactApplicationContext) {

    // L9 fix: pending promise for requestPermissions(). Stored on the
    // helper (not the companion) because each RN instance gets its own
    // module (and thus its own helper). Resolved inside the
    // ActivityResultCallback (via MainActivity.setPermissionResultCallback)
    // so the JS caller's await resolves only after the user actually
    // responds to the system dialog.
    // @Volatile because the callback fires on the main thread but the
    // method is called from the JS thread.
    @Volatile private var pendingPermissionsPromise: Promise? = null

    // L23 fix: pending promise for requestIgnoreBatteryOptimizations().
    // Same pattern as pendingPermissionsPromise — resolved inside the
    // ActivityResultCallback (via MainActivity.setBatteryResultCallback)
    // so the JS caller's await resolves only after the user actually
    // responds to the system dialog.
    @Volatile private var pendingBatteryPromise: Promise? = null

    /**
     * JS-facing (via GpsRecorderModule.requestPermissions delegation).
     *
     * Fast path: if all permissions are already granted, resolves `true`
     * immediately. Otherwise launches the system permission dialog via
     * `MainActivity.requestAllPermissionsFromJs()` and stores the promise
     * in `pendingPermissionsPromise`; the ActivityResultCallback (set via
     * `activity.setPermissionResultCallback`) resolves it.
     *
     * L9 fix: if a second `requestPermissions()` arrives while one is
     * pending, the older promise is rejected with "superseded" so the
     * caller can choose how to react (typically: ignore the rejection
     * and let the new request's result drive the UI).
     */
    fun requestPermissions(promise: Promise) {
        try {
            // Fast path: all permissions already granted.
            if (hasAllPermissions()) {
                promise.resolve(true)
                return
            }
            val activity = reactContext.currentActivity as? MainActivity
            if (activity == null) {
                // Activity not yet attached (e.g. JS mounted before MainActivity
                // resumed). We can't show a dialog without an activity, so resolve
                // false immediately — JS will retry on the next user action.
                Log.w(TAG, "requestPermissions: no Activity attached; resolving false")
                promise.resolve(false)
                return
            }

            // L9 fix: resolve the promise ONLY after the user actually responds
            // to the system dialog. Previously this method launched the dialog
            // asynchronously and immediately resolved with hasAllPermissions()
            // (almost always false at that instant), forcing the JS side into a
            // 30-second polling loop (App.tsx:handleStart).
            //
            // If a second requestPermissions() arrives while one is pending,
            // reject the first with "superseded" so the caller can choose how to
            // react (typically: ignore the rejection and let the new request's
            // result drive the UI).
            pendingPermissionsPromise?.reject("superseded", "Superseded by a newer requestPermissions call")
            pendingPermissionsPromise = promise

            // The callback fires on the main thread when the ActivityResultContracts
            // callback runs (see MainActivity.locationPermissionLauncher). It in
            // turn calls resolvePendingPermissions(hasAllPermissions()).
            activity.setPermissionResultCallback {
                val granted = hasAllPermissions()
                resolvePendingPermissions(granted)
            }

            // Best-effort: also handle the activity being destroyed mid-request
            // (or the RN instance being torn down). The next onResume /
            // onWindowFocusChanged will clear the callback via
            // setPermissionResultCallback(null) (TBD; for now we rely on the
            // 30-second JS timeout as a fallback).
            try {
                activity.requestAllPermissionsFromJs()
            } catch (e: Exception) {
                // Launch failed — reject so JS doesn't hang waiting for a callback
                // that will never fire.
                Log.w(TAG, "requestPermissions: launch failed", e)
                resolvePendingPermissions(false)
            }
        } catch (e: Exception) {
            // Make sure we don't leave a dangling promise if something blew up
            // before we registered the callback.
            try { pendingPermissionsPromise?.reject("E_PERM", e.message ?: "Permission error", e) } catch (_: Exception) {}
            pendingPermissionsPromise = null
            try { promise.reject("E_PERM", e.message ?: "Permission error", e) } catch (_: Exception) {}
        }
    }

    /**
     * Resolves the pending permissions promise (if any) with the given
     * `granted` value and clears the field. Safe to call when no promise is
     * pending (no-op).
     */
    fun resolvePendingPermissions(granted: Boolean) {
        val p = pendingPermissionsPromise
        pendingPermissionsPromise = null
        // Clear the activity-side callback too so a stale closure doesn't fire
        // on a later unrelated permission request.
        try {
            (reactContext.currentActivity as? MainActivity)?.setPermissionResultCallback(null)
        } catch (_: Exception) {}
        if (p != null) {
            try { p.resolve(granted) } catch (_: Exception) {}
        }
    }

    /**
     * JS-facing (via GpsRecorderModule.hasPermissions delegation).
     * Resolves with the current `hasAllPermissions()` value (no request).
     */
    fun hasPermissions(promise: Promise) {
        promise.resolve(hasAllPermissions())
    }

    /**
     * JS-facing (via GpsRecorderModule.requestIgnoreBatteryOptimizations
     * delegation).
     *
     * Fast path: SDK < M (no battery-optimization concept) or already
     * whitelisted → resolves `true`. Otherwise launches the system
     * `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` dialog and stores the
     * promise in `pendingBatteryPromise`; the ActivityResultCallback
     * resolves it.
     *
     * L23 fix (option A): resolve the promise ONLY after the user
     * actually responds to the system dialog. Same `superseded` reject
     * pattern as `requestPermissions`.
     */
    fun requestIgnoreBatteryOptimizations(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                promise.resolve(true); return
            }
            val pm = reactContext.getSystemService(Context.POWER_SERVICE) as PowerManager
            val pkg = reactContext.packageName
            if (pm.isIgnoringBatteryOptimizations(pkg)) {
                promise.resolve(true); return
            }
            val activity = reactContext.currentActivity as? MainActivity
            if (activity == null) {
                // No Activity attached — can't launch the system dialog.
                // Resolve with false so JS knows the request didn't happen.
                Log.w(TAG, "requestIgnoreBatteryOptimizations: no Activity attached; resolving false")
                promise.resolve(false)
                return
            }

            // L23 fix (option A): resolve the promise ONLY after the user
            // actually responds to the system dialog. Previously this method
            // launched the dialog and immediately resolved with
            // pm.isIgnoringBatteryOptimizations(pkg), which almost always
            // returned false because the user hadn't had time to respond.
            //
            // If a second request arrives while one is pending, reject the
            // first with "superseded" (same pattern as requestPermissions).
            pendingBatteryPromise?.reject("superseded", "Superseded by a newer requestIgnoreBatteryOptimizations call")
            pendingBatteryPromise = promise

            // The callback fires on the main thread when the user returns
            // from the system dialog. It calls resolvePendingBatteryOptimization()
            // with the current isIgnoringBatteryOptimizations value.
            activity.setBatteryResultCallback {
                val granted = pm.isIgnoringBatteryOptimizations(pkg)
                resolvePendingBatteryOptimization(granted)
            }

            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$pkg")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            try {
                activity.requestBatteryOptimizationFromJs(intent)
            } catch (e: Exception) {
                // Launch failed — reject so JS doesn't hang.
                Log.w(TAG, "requestIgnoreBatteryOptimizations: launch failed", e)
                resolvePendingBatteryOptimization(false)
            }
        } catch (e: Exception) {
            try { pendingBatteryPromise?.reject("E_BATTERY", e.message ?: "battery opt error", e) } catch (_: Exception) {}
            pendingBatteryPromise = null
            try { promise.reject("E_BATTERY", e.message ?: "battery opt error", e) } catch (_: Exception) {}
        }
    }

    /**
     * Resolves the pending battery-optimization promise (if any) with the
     * given `granted` value and clears the field. Safe to call when no
     * promise is pending (no-op).
     */
    fun resolvePendingBatteryOptimization(granted: Boolean) {
        val p = pendingBatteryPromise
        pendingBatteryPromise = null
        // Clear the activity-side callback too.
        try {
            (reactContext.currentActivity as? MainActivity)?.setBatteryResultCallback(null)
        } catch (_: Exception) {}
        if (p != null) {
            try { p.resolve(granted) } catch (_: Exception) {}
        }
    }

    /**
     * JS-facing (via GpsRecorderModule.openAppSettings delegation).
     * Opens the system "App details" settings page (fallback when the
     * user denies permissions).
     */
    fun openAppSettings(promise: Promise) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.fromParts("package", reactContext.packageName, null)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            reactContext.startActivity(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("E_SETTINGS", e.message ?: "settings error", e)
        }
    }

    // ---- Permission checks (public so GpsRecorderModule.start / GnssMonitor can reuse) ----

    fun hasFineLocation(): Boolean =
        ContextCompat.checkSelfPermission(reactContext, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    fun hasNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            reactContext, Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun hasAllPermissions(): Boolean = hasFineLocation() && hasNotificationPermission()

    /**
     * Called from `GpsRecorderModule.onCatalystInstanceDestroy()` to
     * resolve any pending permission / battery-optimization promise with
     * `false` (so JS doesn't hang waiting for a callback that will never
     * fire after a dev reload) and clear the activity-side callbacks.
     */
    fun teardown() {
        try { pendingPermissionsPromise?.resolve(false) } catch (_: Exception) {}
        pendingPermissionsPromise = null
        // L23 fix: also resolve any pending battery-optimization promise.
        try { pendingBatteryPromise?.resolve(false) } catch (_: Exception) {}
        pendingBatteryPromise = null
        try {
            (reactContext.currentActivity as? MainActivity)?.setPermissionResultCallback(null)
            (reactContext.currentActivity as? MainActivity)?.setBatteryResultCallback(null)
        } catch (_: Exception) {}
    }

    private companion object {
        private const val TAG = "PermissionHelper"
    }
}
