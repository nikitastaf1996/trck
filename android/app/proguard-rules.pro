# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# ---------------------------------------------------------------------------
# React Native / Hermes
# ---------------------------------------------------------------------------
# Keep RN core (called via reflection from JS). Hermes handles its own JS
# bytecode stripping; we just make sure the bridge classes survive.
-keep,allowobfuscation,allowshrinking class com.facebook.react.** { *; }
-keep class com.facebook.react.modules.core.DeviceEventManagerModule { *; }
-keep class com.facebook.react.modules.core.DeviceEventManagerModule$RCTDeviceEventEmitter { *; }

# ---------------------------------------------------------------------------
# Our native module (called via reflection from JS through the bridge)
# ---------------------------------------------------------------------------
-keep class com.gpsrecorder.** { *; }

# ---------------------------------------------------------------------------
# Privacy: strip verbose Log.d / Log.v in release builds (see TODO L33).
# Log.i / Log.w / Log.e are kept — they are useful for diagnosing real
# problems from a bug report and don't leak fine-grained location data
# in a way that verbose debugging logs do.
# ---------------------------------------------------------------------------
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
}

# ---------------------------------------------------------------------------
# Kotlin metadata — keep annotations so reflection-based libraries keep
# working (RN bridge uses some reflection on @ReactMethod).
# ---------------------------------------------------------------------------
-keepattributes RuntimeVisibleAnnotations
-keepattributes RuntimeInvisibleAnnotations
-keepattributes Signature
-keepattributes InnerClasses
-keepattributes EnclosingMethod
