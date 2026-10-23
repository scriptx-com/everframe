<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Real-device quick capture host

A debuggable one-Activity app consuming `dev.everframe:core` and `dev.everframe:reporter-ui` (the documented integration), for checking shake quick capture and device linking on a throwaway emulator or a phone. `HostApplication.onCreate` calls `Everframe.start` with the default configuration and the key from `-PquickCaptureHost.sdkKey` (a synthetic key from your local platform; it is compiled into `BuildConfig` and never logged).

The debug SDK takes its ingest endpoint from `EVERFRAME_DEV_INGEST_URL` when it is built (default `http://10.0.2.2:8787`, the host machine as seen from an emulator). From the Android Gradle root:

    EVERFRAME_DEV_INGEST_URL=http://10.0.2.2:<port> ./gradlew -PquickCaptureQualification=true \
      -PquickCaptureHost.sdkKey=<local key> :quick-capture-host:installDebug

Shake a throwaway emulator with ten alternating impulses, 60 ms apart:

    for i in $(seq 1 10); do adb -s emulator-<port> emu sensor set acceleration 25:0:9.8; sleep 0.06; \
      adb -s emulator-<port> emu sensor set acceleration -25:0:9.8; sleep 0.06; done
