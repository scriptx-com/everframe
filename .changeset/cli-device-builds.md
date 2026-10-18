---
'@everframe/cli': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Add `everframe device-builds upload` and `everframe device-builds status` for uploading runnable builds from CI and waiting for them to be ready for Try on device. Expo and React Native setup now writes the Gradle plugin version of the current Android release, so the CLI can release on its own.
