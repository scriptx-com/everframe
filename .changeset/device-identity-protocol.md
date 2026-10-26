---
"@everframe/protocol": minor
"@everframe/sdk-core": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Reports may carry static app and device identity: `context.app.id` (package, bundle, webOS or Tizen app ID) and `installerPackage`, and `context.device.manufacturer`, `brand`, `cpuAbi`, `emulator`, `totalMemory` and `runtimeVersions`. All optional. `describeWebRuntimeDevice` reads a TV's OS, version, maker and model from its user agent, and `detectWebRuntimePlatform` now recognises Vega OS web views (`Kepler`).
