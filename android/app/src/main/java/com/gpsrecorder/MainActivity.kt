package com.gpsrecorder

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

    companion object {
        @Volatile private var instance: MainActivity? = null

        /**
         * Called from GpsRecorderModule.requestPermissions(). If the activity is alive,
         * we kick off the permission request pipeline; otherwise the caller must call
         * us again when the activity is foregrounded.
         */
        fun requestRequiredPermissions(activity: MainActivity?) {
            activity?.requestAllPermissions()
        }
    }

    private var hasRequestedPermissionsOnLaunch = false

    private val requiredPermissions: Array<String> by lazy {
        val base = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            base.add(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            base.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        base.toTypedArray()
    }

    private val locationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            // After core permissions, if Android 10+, request background location separately
            // (Android requires asking for it after the user has accepted fine location).
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val fineGranted = result[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
                    ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
                        PackageManager.PERMISSION_GRANTED
                if (fineGranted) {
                    try {
                        backgroundLocationLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                    } catch (e: Exception) {
                        // Some devices throw if the activity state is wrong; ignore.
                    }
                }
            }
        }

    private val backgroundLocationLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> /* result ignored */ }

    override fun getMainComponentName(): String = "GpsRecorder"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    override fun onResume() {
        super.onResume()
        instance = this
        // Auto-request permissions on the first resume so the user doesn't have to
        // grant them manually from Android Settings.
        if (!hasRequestedPermissionsOnLaunch) {
            hasRequestedPermissionsOnLaunch = true
            if (!hasAllPermissions()) {
                requestAllPermissions()
            }
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

    fun requestAllPermissions() {
        try {
            locationPermissionLauncher.launch(requiredPermissions)
        } catch (e: Exception) {
            // Some devices throw if the activity is not in a state to launch.
        }
    }
}
