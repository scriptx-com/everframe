<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Real-device quick capture host

A debuggable one-Activity app consuming `dev.everframe:core` and `dev.everframe:reporter-ui` (the documented integration), for checking shake quick capture and device linking on a throwaway emulator or a phone. `HostApplication.onCreate` calls `Everframe.start` with the default configuration and the key from `-PquickCaptureHost.sdkKey` (a synthetic key from your local platform; it is compiled into `BuildConfig` and never logged).

The debug SDK takes its ingest endpoint from `EVERFRAME_DEV_INGEST_URL` when it is built (default `http://10.0.2.2:8787`, the host machine as seen from an emulator). From the Android Gradle root:

    EVERFRAME_DEV_INGEST_URL=http://10.0.2.2:<port> ./gradlew -PquickCaptureQualification=true \
      -PquickCaptureHost.sdkKey=<local key> :quick-capture-host:installDebug

Add `-PquickCaptureHost.releaseMode=true` to start the SDK with `debugBuild = false`: the host still reaches the local platform, and quick capture follows the release-build rules (no capture while unlinked, only the link hello).

Shake a throwaway emulator with ten alternating impulses, 60 ms apart:

    for i in $(seq 1 10); do adb -s emulator-<port> emu sensor set acceleration 25:0:9.8; sleep 0.06; \
      adb -s emulator-<port> emu sensor set acceleration -25:0:9.8; sleep 0.06; done

## Android TV

The manifest adds the Leanback launcher category and marks leanback and touchscreen optional, so the host installs and launches on a throwaway Android TV emulator (for example `system-images;android-31;android-tv;arm64-v8a` or `system-images;android-34;google-tv;arm64-v8a`, created with `hw.keyboard = yes`).

`SpikeActivity` measures key delivery: a list of 20 focusable buttons beside a Media3 `PlayerView` over an `ExoPlayer` with no media item. It logs every key event the window delivers, and every play/pause the player is asked for, under the tag `EvfTvSpike`. Start it with `--es focus player` to focus the player:

    adb -s emulator-<port> shell am start -n dev.everframe.qualification.quickcapture/.SpikeActivity --es focus player
    adb -s emulator-<port> logcat -s EvfTvSpike:I

`adb shell input keyevent` cannot hold a key, and the emulator's `emu event send` does not reach its virtio keyboard. To press like a hardware remote, `tools/hid_remote.py` writes a script for the device's `hid` command, which registers a virtual Bluetooth remote:

    python3 tools/hid_remote.py remote.json down:PLAYPAUSE wait:1600 up:PLAYPAUSE
    adb -s emulator-<port> push remote.json /data/local/tmp/remote.json
    adb -s emulator-<port> shell hid /data/local/tmp/remote.json
