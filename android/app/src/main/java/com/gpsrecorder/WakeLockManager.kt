package com.gpsrecorder

import android.os.PowerManager
import android.util.Log

/**
 * O7 / O24 (round 2) — WakeLock management extracted from
 * GpsRecorderService.kt.
 *
 * L34 invariant preserved: the wakelock is acquired with NO timeout.
 * The previous 6-hour timeout meant that for hikes longer than 6 hours
 * (ultra-marathons, multi-day backpacking), the wakelock was released
 * mid-recording and the CPU could sleep, causing GPS fixes to stop.
 * We rely on [release] in stopRecording / onDestroy to free the wakelock
 * when the recording actually ends.
 */
class WakeLockManager(private val service: GpsRecorderService) {

    private val tag: String get() = GpsRecorderService.TAG

    private var wakeLock: PowerManager.WakeLock? = null

    fun acquire() {
        if (wakeLock?.isHeld == true) return
        val pm = service.getSystemService(GpsRecorderService.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "trck:Recording")
        wakeLock?.setReferenceCounted(false)
        try {
            // L34 fix: NO timeout.
            wakeLock?.acquire()
            Log.i(tag, "Wakelock acquired (no timeout — relies on stopRecording / onDestroy to release)")
        } catch (e: Exception) {
            Log.e(tag, "Failed to acquire wakelock", e)
        }
    }

    fun release() {
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
                Log.i(tag, "Wakelock released")
            }
        } catch (e: Exception) {
            Log.w(tag, "releaseWakeLock", e)
        }
        wakeLock = null
    }
}
