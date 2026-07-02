package com.gpsrecorder

import android.app.ForegroundServiceStartNotAllowedException
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import java.util.Locale

/**
 * O7 / O24 — Foreground notification builder + lifecycle extracted from
 * GpsRecorderService.kt.
 *
 * This class encapsulates:
 *   - Notification channel setup ([ensureNotificationChannel]).
 *   - Notification building ([buildNotification], [buildNotificationWithText])
 *     with auto-pause / signal-lost text variants.
 *   - [startForegroundIfNeeded] — calls `Service.startForeground` with the
 *     correct `FOREGROUND_SERVICE_TYPE_LOCATION` on Android 14+, and catches
 *     `ForegroundServiceStartNotAllowedException` (L18 fix).
 *   - [updateNotification] — refreshes the foreground notification in place.
 *
 * The class holds NO state of its own beyond the [service] reference; all
 * current state (point count, elapsed time, paused / signalLost flags) is
 * passed in via [NotificationSnapshot] at each call. This keeps the helper
 * side-effect-free with respect to the service and makes it trivially
 * testable with a fake service.
 *
 * L18 invariant preserved: the catch block in [startForegroundIfNeeded]
 * releases the wakelock and calls `service.stopSelf()` via the supplied
 * [onFatalError] callback. The caller MUST supply a callback that does
 * both — otherwise the wakelock leaks and the service is left in a half-
 * started state.
 */
class GpsRecorderNotification(private val service: GpsRecorderService) {

    companion object {
        internal const val NOTIFICATION_ID = 0xC0DE
        internal const val CHANNEL_ID = "gps_recorder_channel"
    }

    private val tag: String get() = GpsRecorderService.TAG

    /**
     * Snapshot of the state shown in the notification. Built by the service
     * at each [buildNotification] / [startForegroundIfNeeded] call.
     */
    data class NotificationSnapshot(
        val points: Int,
        val elapsedMs: Long,
        val isAutoPaused: Boolean,
        val signalLost: Boolean
    )

    /**
     * Starts the service in the foreground with a fresh notification built
     * from [snapshot].
     *
     * L18 fix: catches `ForegroundServiceStartNotAllowedException` SPECIFICALLY
     * — this is the Android 12+ exception thrown when startForeground is
     * called from the background (e.g. after a START_STICKY restart that
     * happens while the app is in the background). Without foreground state,
     * Android will kill the service within seconds.
     *
     * Action on catch: invoke [onFatalError] (the service releases the
     * wakelock, emits a fatal error event to JS, and calls stopSelf()).
     *
     * NOTE: per L18, we do NOT catch generic Exception here — other crashes
     * should propagate so we notice them in development.
     */
    fun startForegroundIfNeeded(snapshot: NotificationSnapshot, onFatalError: () -> Unit) {
        ensureNotificationChannel()
        val notification = buildNotification(snapshot)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // Android 14+ requires explicit foregroundServiceType and the
                // FOREGROUND_SERVICE_LOCATION permission.
                service.startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                )
            } else {
                service.startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: ForegroundServiceStartNotAllowedException) {
            Log.e(
                tag,
                "startForeground threw ForegroundServiceStartNotAllowedException — " +
                    "releasing wakelock and stopping",
                e
            )
            onFatalError()
        }
    }

    fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = service.getSystemService(GpsRecorderService.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    service.getString(R.string.notification_channel_name),
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = service.getString(R.string.notification_channel_desc)
                    setShowBadge(false)
                    setSound(null, null)
                    enableVibration(false)
                }
                nm.createNotificationChannel(channel)
            }
        }
    }

    fun buildNotification(snapshot: NotificationSnapshot): Notification {
        return buildNotificationWithText(
            snapshot.points,
            snapshot.elapsedMs,
            snapshot.isAutoPaused,
            snapshot.signalLost
        )
    }

    /**
     * Builds the foreground-service notification with optional auto-pause /
     * signal-lost text variants. Called by [buildNotification] for the normal
     * case and directly when we change pause / signal state and want to
     * refresh the notification immediately.
     */
    private fun buildNotificationWithText(
        points: Int,
        elapsedMs: Long,
        paused: Boolean,
        signalLost: Boolean
    ): Notification {
        val mainIntent = Intent(service, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val mainPi = PendingIntent.getActivity(
            service, 0, mainIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(service, GpsRecorderService::class.java).apply {
            action = GpsRecorderService.ACTION_NOTIFICATION_STOP
        }
        val stopPi = PendingIntent.getService(
            service, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // O11: use Russian plurals for the point count (точка / точки / точек).
        val pointsStr = service.resources.getQuantityString(R.plurals.notification_points, points, points)
        val text = when {
            signalLost -> service.getString(
                R.string.notification_text_signal_lost, pointsStr, formatDuration(elapsedMs)
            )
            paused -> service.getString(
                R.string.notification_text_paused, pointsStr, formatDuration(elapsedMs)
            )
            else -> service.getString(
                R.string.notification_text, pointsStr, formatDuration(elapsedMs)
            )
        }

        return NotificationCompat.Builder(service, CHANNEL_ID)
            .setContentTitle(service.getString(R.string.notification_title))
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_gps_notification)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(mainPi)
            .addAction(0, service.getString(R.string.notification_action_stop), stopPi)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    fun updateNotification(snapshot: NotificationSnapshot) {
        val nm = service.getSystemService(GpsRecorderService.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification(snapshot))
    }

    // O24: This is duplicated in App.tsx (formatDuration). The two MUST stay
    // in sync — if you change the format here, change the JS version too.
    // See CHANGELOG.md / TODO 4, O24 for context.
    private fun formatDuration(ms: Long): String {
        val totalSec = ms / 1000
        val h = totalSec / 3600
        val m = (totalSec % 3600) / 60
        val s = totalSec % 60
        return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s)
        else String.format(Locale.US, "%02d:%02d", m, s)
    }
}
