package com.gpsrecorder

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * L14 fix / refactor (Task K8): the event-emission layer extracted from
 * `GpsRecorderModule`'s companion object.
 *
 * Made an `object` (singleton) so that `GpsRecorderService`,
 * `StateRepository`, and `GpxFileSaver` can emit events without holding a
 * reference to the (per-RN-instance) `GpsRecorderModule`.
 *
 * Lifecycle:
 *   - `GpsRecorderModule.init {}` calls `bind(reactApplicationContext)`
 *     so `send()` can reach `RCTDeviceEventEmitter`.
 *   - `GpsRecorderModule.onCatalystInstanceDestroy()` calls `unbind()` to
 *     null the ref BEFORE tearing down the rest of the module, so the
 *     service stops emitting events into a dead ReactApplicationContext
 *     (the original L14 leak).
 *
 * All six emit functions preserve the EXACT payload shape they had when
 * they were companion-object functions on `GpsRecorderModule`:
 *   - emitLocation      — 12 fields including isAutoPaused / signalLost / movingMs
 *   - emitDuration      — elapsedMs + movingMs + L24 `seq` counter
 *   - emitState         — isRecording + pointCount + elapsedMs + 3 Phase-1/3/4 fields
 *   - emitSaved         — filePath + pointCount + finalDistanceM (-1.0 default)
 *   - emitError         — message + fatal flag (L10 classification)
 *   - emitGnssStatus    — fixType / accuracy / satUsed / satView / hasFix / lat / lon / alt / speed / timestamp
 */
object GpsEventEmitter {

    /**
     * The bound `ReactApplicationContext`. Set by `bind(ctx)` from
     * `GpsRecorderModule.init {}` and nulled by `unbind()` from
     * `onCatalystInstanceDestroy()`. @Volatile because `send()` is called
     * from the service thread while `bind/unbind` happen on the JS thread.
     */
    @Volatile private var instance: ReactApplicationContext? = null

    /**
     * L24 fix: monotonically increasing sequence number for 'duration'
     * events. Incremented on every `emitDuration` call so the JS side can
     * ignore any 'duration' event whose seq is less than the last one it
     * processed (e.g. when a getState() poll delivers an older elapsedMs
     * value just after a duration event).
     */
    @Volatile private var durationSeq: Int = 0

    /**
     * Binds the singleton to a live `ReactApplicationContext`. Called from
     * `GpsRecorderModule.init {}` so that subsequent `send()` calls can
     * reach `RCTDeviceEventEmitter`.
     */
    fun bind(ctx: ReactApplicationContext) {
        instance = ctx
    }

    /**
     * Unbinds the singleton. Called from
     * `GpsRecorderModule.onCatalystInstanceDestroy()` BEFORE any other
     * teardown so that the service stops emitting into a dead context.
     */
    fun unbind() {
        instance = null
    }

    // ---- Event emitters called from GpsRecorderService ----

    fun emitLocation(
        lat: Double, lon: Double, alt: Double?, speed: Float?, accuracy: Float?,
        fixType: String, distanceMeters: Double,
        timestamp: Long, pointCount: Int,
        isAutoPaused: Boolean = false,
        signalLost: Boolean = false,
        movingMs: Long = 0L
    ) {
        val map = Arguments.createMap().apply {
            putDouble("lat", lat)
            putDouble("lon", lon)
            if (alt != null) putDouble("alt", alt) else putNull("alt")
            if (speed != null) putDouble("speed", speed.toDouble()) else putNull("speed")
            if (accuracy != null) putDouble("accuracy", accuracy.toDouble()) else putNull("accuracy")
            putString("fixType", fixType)
            putDouble("distance", distanceMeters)
            putDouble("timestamp", timestamp.toDouble())
            putInt("pointCount", pointCount)
            // Phase 1/3/4: auto-pause / signal-lost / moving-time so the
            // JS UI can reflect pause / gap status in real time.
            putBoolean("isAutoPaused", isAutoPaused)
            putBoolean("signalLost", signalLost)
            putDouble("movingMs", movingMs.toDouble())
        }
        send("location", map)
    }

    fun emitDuration(elapsedMs: Long, movingMs: Long = 0L) {
        // L24 fix: increment the sequence number on every emit. JS uses
        // this to ignore out-of-order events (e.g. a getState() poll
        // delivering an older elapsedMs value just after a duration event).
        val seq = ++durationSeq
        val map = Arguments.createMap().apply {
            putDouble("elapsedMs", elapsedMs.toDouble())
            // L8 fix: include movingMs in the 1 Hz duration tick so the JS
            // pace computation doesn't oscillate second-by-second between
            // the live 'duration' tick and the much-less-frequent 'location'
            // event's movingMs (which can be 0 for many seconds while the
            // user is stationary under auto-pause).
            putDouble("movingMs", movingMs.toDouble())
            // L24 fix: include the sequence number so JS can detect /
            // ignore out-of-order events.
            putInt("seq", seq)
        }
        send("duration", map)
    }

    fun emitState(
        isRecording: Boolean,
        pointCount: Int,
        elapsedMs: Long,
        isAutoPaused: Boolean = false,
        signalLost: Boolean = false,
        movingMs: Long = 0L
    ) {
        val map = Arguments.createMap().apply {
            putBoolean("isRecording", isRecording)
            putInt("pointCount", pointCount)
            putDouble("elapsedMs", elapsedMs.toDouble())
            // Phase 1/3/4: include auto-pause / signal-lost / moving-time
            // so JS can poll via getState() and stay in sync after a
            // service restart.
            putBoolean("isAutoPaused", isAutoPaused)
            putBoolean("signalLost", signalLost)
            putDouble("movingMs", movingMs.toDouble())
        }
        send("state", map)
    }

    fun emitSaved(filePath: String, pointCount: Int, finalDistanceM: Double = -1.0) {
        val map = Arguments.createMap().apply {
            putString("filePath", filePath)
            putInt("pointCount", pointCount)
            // Final distance (meters) computed from the SAVED GPX file,
            // post-smoothing. Negative / -1 means "not available; keep
            // the live-accumulated distance". When Gaussian smoothing is
            // applied the smoothed track's length can differ from the
            // raw live-accumulated distance by a few percent, so we send
            // the post-save distance to keep the UI in sync with what
            // the user will see when they import the GPX elsewhere.
            putDouble("finalDistanceM", finalDistanceM)
        }
        send("saved", map)
    }

    /**
     * Emits an 'error' event to JS.
     *
     * L10 fix: errors are now classified as fatal or non-fatal.
     *
     *  - Fatal: the service has actually stopped (or is about to stop).
     *    Examples: missing location permission, no provider enabled,
     *    startForeground threw. The JS UI SHOULD reset to idle when it
     *    sees a fatal error so the user can press START again.
     *
     *  - Non-fatal: a transient / informational failure that does NOT
     *    tear down the service. Example: recomputeDistanceFromSavedGpx
     *    failed (UI falls back to the live-accumulated distance). The
     *    JS UI MUST NOT reset to idle on a non-fatal error — doing so
     *    would enable the user to press START while a recording is
     *    actually still running on the native side, which would reset
     *    state and lose the in-progress track.
     *
     * The `fatal` flag is included in the event payload so the JS
     * handler can decide whether to flip the UI to idle.
     */
    fun emitError(message: String, fatal: Boolean = false) {
        val map = Arguments.createMap().apply {
            putString("message", message)
            putBoolean("fatal", fatal)
        }
        send("error", map)
    }

    /**
     * Emits a 'gnss' event with the current live GNSS status (independent of
     * recording). Called by the always-on monitor in [GnssMonitor].
     */
    fun emitGnssStatus(
        fixType: String,
        accuracy: Float?,
        satellitesUsed: Int,
        satellitesInView: Int,
        hasFix: Boolean,
        lat: Double?,
        lon: Double?,
        altitude: Double?,
        speed: Float?
    ) {
        val map = Arguments.createMap().apply {
            putString("fixType", fixType)
            if (accuracy != null) putDouble("accuracy", accuracy.toDouble()) else putNull("accuracy")
            putInt("satellitesUsed", satellitesUsed)
            putInt("satellitesInView", satellitesInView)
            putBoolean("hasFix", hasFix)
            if (lat != null) putDouble("lat", lat) else putNull("lat")
            if (lon != null) putDouble("lon", lon) else putNull("lon")
            if (altitude != null) putDouble("alt", altitude) else putNull("alt")
            if (speed != null) putDouble("speed", speed.toDouble()) else putNull("speed")
            putDouble("timestamp", System.currentTimeMillis().toDouble())
        }
        send("gnss", map)
    }

    /**
     * Forwards an event to JS via `RCTDeviceEventEmitter`. Swallows any
     * exception (the JS app may not be alive, the ReactApplicationContext
     * may have been torn down, etc.) — same behaviour as the original
     * `GpsRecorderModule.send()`.
     */
    private fun send(eventName: String, params: WritableMap) {
        val ctx = instance ?: return
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        } catch (e: Exception) {
            // JS app may not be alive; that's fine.
        }
    }
}
