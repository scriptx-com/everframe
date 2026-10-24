---
'@everframe/web': minor
'@everframe/react': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

**Deprecated: Everframe Companion has been removed.** The documented Companion API stays as deprecated no-op stubs, so apps that follow the docs keep compiling. Pairing calls do nothing: the first `companion.start()` (or top-level `start()`) on a page logs one warning, "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.", and opens no socket and makes no request. `stop()` does nothing; `createCompanion()` and `__getCompanionApi()` return a surface whose getters are idle (`'unpaired'`, `null`) and whose `on*` subscriptions return an unsubscribe and never fire. Every `CompanionStartOptions` field is still accepted. From `@everframe/web/ui`, `CompanionBadge` and `CompanionPinCard` render nothing, and `EverframeProvider` no longer renders them. `@everframe/react`'s `useCompanion()` returns the same idle object on every render. These APIs are deleted at the next major version.

The SDK no longer sends the `X-Everframe-Companion-Attribution` header or declares the `companionbadge` capability; a config that still carries a `companionBadge` block parses and the block is ignored. Crash-only sessions (`reporter: { disabled: true }`) no longer upgrade when a phone pairs.

Kept, deprecated: the `companion` namespace (`start`, `stop`, `createCompanion`), the top-level `start`, `stop`, `createCompanion` and `__getCompanionApi`, the types `CompanionAPI`, `CompanionState`, `CompanionAttachChallenge`, the `Companion*Handler` types, `CompanionStartOptions`, `AttachPinUiMode`, `CompanionBadgeOptions` and `BadgePosition`, and, as types only so existing `companion.start()` callbacks keep compiling, `ReportSubmit`, `RelayMessage`, `RelayWSClient` and `ReportCounts`; in `@everframe/react`, `companion` (the same members plus `useCompanion`), `useCompanion` and `CompanionState`.

Removed (undocumented plumbing), from `@everframe/web` and the matching re-exports from `@everframe/react`:

- `announce`, `AnnounceResult` and `AnnounceDeviceBlock`
- `createRelayWSClient` and `RelayWSClientOpts`
- `handleReportRequest`, `handleCompanionSubmitText` and `handleCompanionSubmitBinary`
- every `__*Companion*` seam except `__getCompanionApi` (`__setCompanionHost`, `__getCompanionHost`, `__companionSeamTicket`, `__watchCompanionBond`, `__setCompanionDefaults`, `__getCompanionRunning`, `__onCompanionRunning`, `__getAttachPinUiMode`, `__getCompanionBadgeConfig`, `__setCompanionBadgeServerConfig`, `__getCompanionBadgeServerConfig`, `__subscribeCompanionBadgeServerConfig`) and the `CompanionHost` / `CompanionSeamTicket` types
- `__resetDeviceIdForTests`
- the `__setCompanionAttached` adapter seam
