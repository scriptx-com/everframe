<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Compose Desktop macOS renderer capture probe

Date: 2026-09-28. Public local branch: `codex/macos-desktop-probe`. Toolchain: Kotlin 2.4.20, Gradle 8.10.2, JDK 21, macOS 27.0. The original AWT probe used Compose Multiplatform 1.12.1; the renderer probe uses 1.13.0-alpha01.

`./gradlew test --no-daemon` passed 4 tests. `./gradlew run --args=--auto-probe --no-daemon` launched the macOS app and wrote only PNGs that had been masked in memory and scanned for magenta pixels. The printed `EVERFRAME_COMPOSE_PROBE_DIR` points to temporary, uncommitted artifacts.

| AWT `printAll` candidate | Measured result | Capability |
| --- | --- | --- |
| Compose public tiles | Green A coverage 0; blue B coverage 0 in 800×572 frames | Screenshot **BLOCKED** |
| Compose sensitive tile | Black region coverage 1.0, but Compose pixels are absent from the source | Full-UI masking **BLOCKED** |
| Native Swing view | Orange coverage 1.0 in both frames | Native view **PASS** |
| Transition | A and B PNGs are byte-identical | Visual replay **BLOCKED** |

Standard AWT component readback is unsuitable as the sole Compose Desktop visual source: it omits the primary Compose UI. The sample now also calls `ComposeWindow.captureContentToImage()` on the AWT event thread, masks a fixed sensitive rectangle in memory, scans for secret-colored pixels, and then encodes the PNG. This API is marked for tooling and was unavailable in Compose 1.12.1, so it is an experimental candidate rather than a stable SDK contract.

`./gradlew test run --args=--auto-probe --no-daemon --console=plain` passed and produced two 1600×1144 renderer frames. Green A and blue B public coverage were each 1.0; black sensitive coverage was 1.0 in both; orange Swing view coverage was 1.0 in both; and the frames differed. The classifier returned **PASS** for screenshot, masking, native view, and visual replay in this fixed scene. The sample switches state automatically; it does not prove that user interaction events were recorded. Mask geometry is hard-coded, and arbitrary Compose layouts, popups, privacy annotations, resize, display scaling, and Windows/Linux are untested. No reporting SDK or backend was involved.
