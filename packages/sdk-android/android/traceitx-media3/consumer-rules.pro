# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# :traceitx-media3 CONSUMER-level R8/proguard rules — applied to the HOST
# app's own R8 pass at their release-build time (wired via
# `defaultConfig { consumerProguardFiles("consumer-rules.pro") }`).
#
# Sister file of `proguard-rules.pro`, which carries the identical list for
# THIS module's own R8 pass at publish time. Same two-file rationale as
# :traceitx-core's pair: a symbol kept at publish time but not here ships
# readable in the AAR and is renamed again in the customer's APK — which is
# exactly the shape that breaks a customer calling `TraceItX.trackPlayer(...)`
# (the top-level extension compiles to the `TrackPlayerKt` facade, derived
# from the FILE name) or holding a `Media3Integration`.
#
# Only the public surface is kept; the facade seam, the AnalyticsListener
# mapping and the rest of the internals stay obfuscated, matching core's
# "internal helpers ... all renamed" policy.
-keep class com.traceitx.media3.TrackPlayerKt { public *; }
-keep class com.traceitx.media3.Media3Integration { public *; }
