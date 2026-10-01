<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Compose Desktop capture probe

This unreleased macOS/JVM sample tests standard AWT component image readback against a Compose scene with an embedded orange `SwingPanel`. The public tile changes from green to blue; the sensitive tile moves and its mask follows measured Compose layout bounds. Frames are masked in memory, scanned for magenta, and encoded only when safe.

The renderer sample pins Kotlin 2.4.20, Compose Multiplatform 1.13.0-alpha01, Gradle 8.10.2, and JDK 21. Run `./gradlew test run --args=--auto-probe`. It prints a temporary artifact directory containing safe PNGs and `renderer-evidence.json`. The renderer path includes Compose and Swing pixels in this sample; the older AWT `printAll` candidate omits Compose pixels.

No SDK package, credential, backend request, or release is involved.
