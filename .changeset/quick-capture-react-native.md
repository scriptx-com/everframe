---
"@everframe/react-native": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Adds `quickCapture: { enabled }` to the provider config. Simulator and emulator quick capture is on by default in debug builds once the dashboard enables it; `quickCapture: { enabled: false }` opts the app out. The value reaches the native iOS and Android SDKs as `quickCaptureEnabled`, and a local `true` never overrides a dashboard disable.
