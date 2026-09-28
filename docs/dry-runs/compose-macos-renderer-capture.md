<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Compose Desktop macOS renderer capture probe

Date: 2026-09-28. Public sample revision: `43a564e5f16639803a7856a435a96c7ab40e7043` on local branch `codex/macos-desktop-probe`. Toolchain: Kotlin 2.4.20, Compose Multiplatform 1.12.1, Gradle 8.10.2, JDK 21, macOS 27.0.

`./gradlew test --no-daemon` passed 4 tests. `./gradlew run --args=--auto-probe --no-daemon` launched the macOS app and wrote only PNGs that had been masked in memory and scanned for magenta pixels. The printed `EVERFRAME_COMPOSE_PROBE_DIR` points to temporary, uncommitted artifacts.

| AWT `printAll` candidate | Measured result | Capability |
| --- | --- | --- |
| Compose public tiles | Green A coverage 0; blue B coverage 0 in 800×572 frames | Screenshot **BLOCKED** |
| Compose sensitive tile | Black region coverage 1.0, but Compose pixels are absent from the source | Full-UI masking **BLOCKED** |
| Native Swing view | Orange coverage 1.0 in both frames | Native view **PASS** |
| Transition | A and B PNGs are byte-identical | Visual replay **BLOCKED** |

The automatic run changes the sample state; it does not prove a user interaction was recorded. Standard AWT component readback is therefore unsuitable as the sole Compose Desktop visual source: it omits the primary Compose UI, not just optional media. The next candidate is an in-process Compose renderer capture with masking. ScreenCaptureKit remains a separate comparison path that requires permission. No reporting SDK or backend was involved.
