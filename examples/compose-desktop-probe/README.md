<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Compose Desktop capture probe

This unreleased macOS/JVM sample tests standard AWT component image readback against a Compose scene with an embedded orange `SwingPanel`. The public tile changes from green to blue; the magenta tile is sensitive. Frames are masked in memory, scanned for magenta, and encoded only when safe.

The sample pins Kotlin 2.4.20, Compose Multiplatform 1.12.1, Gradle 8.10.2, and JDK 21. Run `./gradlew test` and `./gradlew run --args=--auto-probe`. The latter prints a temporary artifact directory containing safe PNGs and `renderer-evidence.json`. This candidate's current result is **BLOCKED** for a full screenshot and visual replay because AWT readback includes the Swing view but omits Compose pixels.

No SDK package, credential, backend request, or release is involved.
