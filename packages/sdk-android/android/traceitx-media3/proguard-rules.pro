# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# :traceitx-media3 LIBRARY-level R8/proguard rules — this module's own R8 pass
# at publish time. `consumer-rules.pro` carries the same keeps for the HOST
# app's pass; see its header for why both exist.
-keep class com.traceitx.media3.TrackPlayerKt { public *; }
-keep class com.traceitx.media3.Media3Integration { public *; }

# Same suppression :traceitx-core carries: JVM 9+ invokedynamic string
# concatenation desugars against a bootstrap class that is not on the Android
# API surface. Not a real missing dependency.
-dontwarn java.lang.invoke.StringConcatFactory
