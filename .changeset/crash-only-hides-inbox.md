---
"@everframe/web": patch
"@everframe/react": patch
"@everframe/react-native": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

A crash-only session (`reporter: { disabled: true }`) no longer shows the floating "Your reports" button or the inbox, even when the device has reply threads. The session has no on-device way to open the reporter, so it has no inbox either. Sessions with the reporter enabled are unchanged, including the read-only inbox after replies are switched off. On React Native this applies to React Native Web.
