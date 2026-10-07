<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Web release exposures

The imperative `@everframe/web` lifecycle can collect anonymous release exposure observations independently of replay and playback vitals:

```ts
const sdk = init({
  apiKey: 'your-sdk-key',
  vitals: { enabled: false },
  releaseHealth: { enabled: true, loadedBuildId: 'actually-executed-build-id' },
});
const readiness = await sdk.releaseHealth.ready;
const diagnostics = await sdk.releaseHealth.diagnostics();
```

Pass the ID of the bundle executing this code. Omit the build ID when it is unknown. A fetched update is not a loaded bundle. Changing a bundle requires `destroy()` and a new `init()`; this creates a new exposure segment while preserving the page-launch identity. The React Provider and native SDKs do not yet implement this option.

A start is committed to IndexedDB before its exposure token becomes available. Records survive reload and retain their original build and route. The queue holds at most256 records/1MiB for7days; capacity rejection, expiry and terminal rejection are visible through diagnostics and future exposure coverage. Unavailable storage is reported as `unavailable`; there is no silent in-memory fallback. Requests time out after10seconds and retry on the next init, online event or explicit `flush()`.

`destroy()` and `pagehide` attempt to persist an end boundary. A BFCache restore opens another segment. Browser termination can interrupt these asynchronous writes, so missing ends remain unknown. Neither an end nor its absence establishes a healthy or crashed process. Background visibility changes do not end an exposure.

`kill()`, `disabled:true` and explicit `releaseHealth.enabled:false` revoke this credential route and erase its queued records. Requests already handed to the network cannot be recalled reliably. A unique persisted generation prevents older pending work from resuming after revocation. Ordinary `destroy()` preserves offline delivery for the next init. Records for another SDK key or endpoint never drain under the current credentials; after key rotation, records scoped to the old key remain pending until expiry unless explicitly erased under that old route.

No user, reporter, install or device identifiers are collected. `exposureId` identifies an observation segment, and `pageLaunchId` identifies this document lifetime. Neither is a person or a native process identifier. Sampling of opted-in segments is1, but SDK opt-in, blocked persistence, offline expiry and unsupported producers make population coverage incomplete. These observations do not provide a crash-free percentage or a reliable user denominator.
