package com.gpsrecorder

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

    companion object {
        private const val TAG = "MainActivity"

        @Volatile private var instance: MainActivity? = null

        /**
         * Process-wide flag: becomes true the first time we successfully fire the
         * permission dialog in this process. Prevents spamming the user with dialogs
         * on every onResume / onWindowFocusChanged.
         *
         * Reset to false automatically when the app process dies, so the next cold
         * start asks again (which is what we want).
         */
        @Volatile private var hasRequestedInThisProcess = false

        /**
         * Called from GpsRecorderModule.requestPermissions(). Always tries to launch
         * the system permission dialog (ignores the auto-launch flag), because the
         * user explicitly tapped the "Grant permissions" button.
         */
        fun requestRequiredPermissions(activity: MainActivity?) {
            activity?.requestAllPermissionsFromJs()
        }
    }

    /**
     * Per-instance flag. Set when we attempted the auto-launch on this activity
     * instance. Used together with [hasRequestedInThisProcess] to deduplicate
     * triggers from onResume / onWindowFocusChanged / onPostResume.
     */
    private var hasAutoRequestedOnThisInstance = false

    /**
     * Core permissions to request up-front.
     *
     * NOTE: ACCESS_BACKGROUND_LOCATION is deliberately NOT in this list. On
     * Android 11+ (API 30+), requesting ACCESS_BACKGROUND_LOCATION together
     * with the foreground location permissions causes the system to silently
     * ignore the entire batch (or show a confusing dialog). The correct
     * pattern is to request foreground location first, then ask for background
     * location separately after the user grants foreground. We do that in
     * [locationPermissionLauncher]'s callback.
     */
    private val corePermissions: Array<String> by lazy {
        val base = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            base.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        base.toTypedArray()
    }

    private val locationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
            // After the core batch resolves, ask for background location separately
            // (only if fine location was granted). Android 10+ requires this to be
            // a separate, follow-up request.
            //
            // L9 fix: also notify any pending JS permission request that the user
            // has responded. The result of the *core* batch is what JS needs to
            // know about (foreground location + notifications); the background-
            // location follow-up is best-effort and its outcome is reported
            // separately via the next hasPermissions() call.
            notifyPermissionResult()
            requestBackgroundLocationIfPossible()
        }

    private val backgroundLocationLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
            /* result ignored — best-effort */
        }

    /**
     * L9 fix: callback invoked when the user actually responds to the core
     * permission dialog. Set by [GpsRecorderModule.requestPermissions] and
     * cleared after it fires. Stored statically so a re-created activity
     * (configuration change, process restart) can still notify the pending
     * request — though in practice the module survives across activity
     * recreation because it lives on the ReactApplicationContext.
     */
    @Volatile
    private var permissionResultCallback: (() -> Unit)? = null

    fun setPermissionResultCallback(cb: (() -> Unit)?) {
        permissionResultCallback = cb
    }

    private fun notifyPermissionResult() {
        permissionResultCallback?.let { cb ->
            permissionResultCallback = null
            try { cb() } catch (e: Exception) {
                Log.w(TAG, "Permission result callback threw", e)
            }
        }
    }

    override fun getMainComponentName(): String = "trck"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    override fun onResume() {
        super.onResume()
        instance = this
        // Auto-request on first resume so the user doesn't have to grant permissions
        // manually from Android Settings.
        maybeAutoRequestPermissions()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // Fallback trigger: some devices/ROMs fire onResume before the activity is
        // truly ready to launch the ActivityResult contract. If we still don't have
        // permissions when the window gets focus, try again.
        if (hasFocus) {
            maybeAutoRequestPermissions()
        }
    }

    /**
     * Auto-request permissions once per process. Safe to call from multiple
     * lifecycle hooks — deduplicates via [hasRequestedInThisProcess].
     */
    private fun maybeAutoRequestPermissions() {
        if (hasRequestedInThisProcess) return
        if (hasAutoRequestedOnThisInstance) return
        if (hasAllPermissions()) return

        // Mark immediately to prevent concurrent triggers from double-firing.
        // We reset to false if the actual launch() call throws.
        hasRequestedInThisProcess = true
        hasAutoRequestedOnThisInstance = true

        // Post to the decorView's queue so the activity is fully attached and
        // resumed before we try to launch the ActivityResult contract. Launching
        // synchronously inside onResume can silently fail on some Android versions
        // because the activity is not yet in STARTED state from the
        // ActivityResultRegistry's point of view.
        window.decorView.post {
            try {
                if (!hasAllPermissions()) {
                    locationPermissionLauncher.launch(corePermissions)
                    Log.i(TAG, "Auto-requested core permissions: ${corePermissions.toList()}")
                }
            } catch (e: Exception) {
                // Reset flags so we can retry on the next trigger (next resume,
                // next window focus change, or next JS call).
                hasRequestedInThisProcess = false
                hasAutoRequestedOnThisInstance = false
                Log.w(TAG, "Permission launch failed, will retry on next trigger", e)
            }
        }
    }

    /**
     * Called from JS via [GpsRecorderModule.requestPermissions]. Always tries to
     * launch the dialog (the user explicitly asked), regardless of the auto-launch
     * flags.
     */
    fun requestAllPermissionsFromJs() {
        // Mark as requested so onResume / onWindowFocusChanged don't double-fire.
        hasRequestedInThisProcess = true
        hasAutoRequestedOnThisInstance = true

        window.decorView.post {
            try {
                if (!hasAllPermissions()) {
                    locationPermissionLauncher.launch(corePermissions)
                    Log.i(TAG, "JS-requested core permissions: ${corePermissions.toList()}")
                }
            } catch (e: Exception) {
                // Reset so the auto-launch path can try again later.
                hasAutoRequestedOnThisInstance = false
                Log.w(TAG, "Permission launch from JS failed", e)
            }
        }
    }

    private fun requestBackgroundLocationIfPossible() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val fineGranted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        if (!fineGranted) return
        try {
            backgroundLocationLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        } catch (e: Exception) {
            // Some devices throw if the activity state is wrong; ignore.
            Log.w(TAG, "Background location launch failed", e)
        }
    }

    private fun hasAllPermissions(): Boolean {
        val fineGranted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val notifGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                this, Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        } else true
        return fineGranted && notifGranted
    }
}
