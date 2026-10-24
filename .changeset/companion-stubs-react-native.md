---
'@everframe/react-native': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

**Deprecated: Everframe Companion has been removed.** The `companion` namespace stays as deprecated no-op stubs, so apps that follow the docs keep compiling. Pairing calls do nothing: the first `companion.start()` logs one warning, "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.", and reaches no native code. `companion.stop()` does nothing, `onRunning`, `onState`, `onPairUrl`, `onCode`, `onAttachedUserName`, `onResolvedName` and `onAttachChallenge` return an unsubscribe and never call their handler, and `useCompanion()` returns the same idle object on every render (`state: 'unpaired'`, `running: false`, every other value `null`). The `attachPinUi`, `companionDeviceId` and `companionBadge` config options are accepted and no longer forwarded to native. These APIs are deleted at the next major version.

The native SDKs no longer send the `X-Everframe-Companion-Attribution` header or declare the `companionbadge` capability, and crash-only sessions (`reporter: { disabled: true }`) no longer upgrade when a phone pairs. `ReporterTrigger` keeps `'companion'` for reports filed by older builds.

Removed:

- `companion.getEmitter` (`getEmitter` itself stays in the SDK's internals)
- the `startCompanion`, `stopCompanion` and `signalCompanionReportRequestReady` TurboModule methods, and the `attachPinUi`, `companionDeviceId`, `companionBadgeEnabled` and `companionBadgePosition` `ConfigOpts` fields
- the `everframe.companion.*` native events
