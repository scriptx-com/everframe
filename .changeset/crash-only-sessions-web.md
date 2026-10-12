---
"@everframe/web": minor
"@everframe/react": minor
"@everframe/react-native": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

New `reporter: { disabled: true }` config option for crash-only sessions. Such a session reports crashes and errors but has no on-device way to file a report: no hotkey, no "New report" button in the inbox, and `open()` rejects with the new `EverframeReporterDisabledError`. Session replay samples against the app's crash-only rate, which is 0 unless the dashboard raises it, and network bodies are not captured. A companion bond upgrades the session to the normal replay and network-body settings for the rest of the session, and recording starts at the bond. Errors carry a replay only while the session records. On React Native, the option is passed to the native SDKs, and `open()` maps their refusal to `EverframeReporterDisabledError`.
