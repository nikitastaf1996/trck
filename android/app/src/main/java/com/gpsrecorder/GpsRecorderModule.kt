package com.gpsrecorder

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * React Native bridge to GpsRecorderService.
 *
 * Methods exposed to JS:
 *   - start()                      -> starts recording
 *   - stop()                       -> stops and saves GPX file (resolves with {filePath, pointCount})
 *   - isRecording()                -> Promise<Boolean>
 *   - requestPermissions()         -> Promise<Boolean> (location + notifications + battery)
 *   - hasPermissions()             -> Promise<Boolean> (no request, just check)
 *   - requestIgnoreBatteryOptimizations() -> Promise<Boolean>
 *   - openAppSettings()            -> void (fallback when user denies permissions)
 *   - addListener(String)          -> required by NativeEventEmitter
 *   - removeListeners(Integer)     -> required by NativeEventEmitter
 *
 * Events emitted to JS:
 *   - "location"  { lat, lon, alt, speed, accuracy, timestamp }
 *   - "duration"  { elapsedMs }
 *   - "state"     { isRecording, pointCount, elapsedMs }
 *   - "saved"     { filePath, pointCount }
 *   - "error"     { message }
 */
class GpsRecorderModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "GpsRecorderModule"
        // Singleton reference so the Service can emit events without depending on JS being alive.
        @Volatile private var instance: GpsRecorderModule? = null

        // ---- Event emitters called from GpsRecorderService ----
        fun emitLocation(lat: Double, lon: Double, alt: Double?, speed: Float?, accuracy: Float?, timestamp: Long) {
            val module = instance ?: return
            val map = Arguments.createMap().apply {
                putDouble("lat", lat)
                putDouble("lon", lon)
                if (alt != null) putDouble("alt", alt) else putNull("alt")
                if (speed != null) putDouble("speed", speed.toDouble()) else putNull("speed")
                if (accuracy != null) putDouble("accuracy", accuracy.toDouble()) else putNull("accuracy")
                putDouble("timestamp", timestamp.toDouble())
            }
            module.send("location", map)
        }

        fun emitDuration(elapsedMs: Long) {
            val module = instance ?: return
            val map = Arguments.createMap().apply {
                putDouble("elapsedMs", elapsedMs.toDouble())
            }
            module.send("duration", map)
        }

        fun emitState(isRecording: Boolean, pointCount: Int, elapsedMs: Long) {
            val module = instance ?: return
            val map = Arguments.createMap().apply {
                putBoolean("isRecording", isRecording)
                putInt("pointCount", pointCount)
                putDouble("elapsedMs", elapsedMs.toDouble())
            }
            module.send("state", map)
        }

        fun emitSaved(filePath: String, pointCount: Int) {
            val module = instance ?: return
            val map = Arguments.createMap().apply {
                putString("filePath", filePath)
                putInt("pointCount", pointCount)
            }
            module.send("saved", map)
        }

        fun emitError(message: String) {
            val module = instance ?: return
            val map = Arguments.createMap().apply { putString("message", message) }
            module.send("error", map)
        }
    }

    init { instance = this }

    override fun getName(): String = "GpsRecorder"

    override fun getConstants(): Map<String, Any> = emptyMap()

    // ---- JS-callable methods ----

    @ReactMethod
    fun start(promise: Promise) {
        try {
            if (!hasFineLocation()) {
                promise.reject("E_PERMISSION", "Location permission not granted")
                return
            }
            val ctx = reactContext
            val intent = Intent(ctx, GpsRecorderService::class.java).apply {
                action = GpsRecorderService.ACTION_START
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("E_START", e.message ?: "Failed to start", e)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        try {
            val ctx = reactContext
            val intent = Intent(ctx, GpsRecorderService::class.java).apply {
                action = GpsRecorderService.ACTION_STOP
            }
            ctx.startService(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("E_STOP", e.message ?: "Failed to stop", e)
        }
    }

    @ReactMethod
    fun isRecording(promise: Promise) {
        val prefs = reactContext.getSharedPreferences("gps_recorder_state", Context.MODE_PRIVATE)
        promise.resolve(prefs.getBoolean("is_recording", false))
    }

    @ReactMethod
    fun requestPermissions(promise: Promise) {
        try {
            // We can't directly request permissions from a non-Activity context here without
            // launching an Activity. The MainActivity hosts the permission request and reads
            // the result back. For simplicity, we launch the system permission dialog via
            // an Intent, and return whether we ALREADY have all permissions.
            val allGranted = hasAllPermissions()
            if (allGranted) {
                promise.resolve(true)
                return
            }
            // Otherwise, request via MainActivity (handled in MainApplication / MainActivity)
            MainActivity.requestRequiredPermissions(reactContext.currentActivity as? MainActivity)
            promise.resolve(hasAllPermissions())
        } catch (e: Exception) {
            promise.reject("E_PERM", e.message ?: "Permission error", e)
        }
    }

    @ReactMethod
    fun hasPermissions(promise: Promise) {
        promise.resolve(hasAllPermissions())
    }

    @ReactMethod
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
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$pkg")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            reactContext.startActivity(intent)
            promise.resolve(pm.isIgnoringBatteryOptimizations(pkg))
        } catch (e: Exception) {
            promise.reject("E_BATTERY", e.message ?: "battery opt error", e)
        }
    }

    @ReactMethod
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

    @ReactMethod
    fun addListener(eventName: String) { /* required by NativeEventEmitter, no-op */ }

    @ReactMethod
    fun removeListeners(count: Int) { /* required by NativeEventEmitter, no-op */ }

    // ---- Internal helpers ----

    private fun hasFineLocation(): Boolean =
        ContextCompat.checkSelfPermission(reactContext, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun hasNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            reactContext, Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasAllPermissions(): Boolean = hasFineLocation() && hasNotificationPermission()

    private fun send(eventName: String, params: WritableMap) {
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        } catch (e: Exception) {
            // JS app may not be alive; that's fine.
        }
    }
}
