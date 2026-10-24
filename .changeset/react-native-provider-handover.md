---
'@everframe/react-native': patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

A new `EverframeProvider` takes over from a still-mounted one instead of throwing "already mounted". Android recreates the activity while the JS runtime survives (for example after a system font or display size change), and the new root's provider can mount before the old root's cleanup runs; that threw from a layout effect and crashed the app. The replaced provider's late unmount is a no-op, and mounting the same provider twice still throws. This restores the 1.4.1 hotfix, which 1.5.0 and 1.6.0 did not carry.
