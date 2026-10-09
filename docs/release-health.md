<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Release health observations

Web, React, Android and iOS can collect release observations independently of
replay and playback vitals. Collection is opt-in. These producers emit version 2
records; the receiving service must support that version before they are enabled.
Older version-1 records already queued locally remain deliverable after upgrade.

```ts
const sdk = init({
  apiKey: 'your-sdk-key',
  vitals: { enabled: false },
  releaseHealth: {
    enabled: true,
    loadedBuildId: 'actually-executed-build-id',
    // Optional: a project-local opaque account ID, only with the host's consent.
    userId: 'opaque-account-id',
  },
});
await sdk.releaseHealth.ready;
const diagnostics = await sdk.releaseHealth.diagnostics();
```

The React Provider accepts the same `releaseHealth` configuration. Remount the
Provider to change it. Android's `ReleaseHealthConfig` and iOS's
`ReleaseHealthConfiguration` also accept an optional `userId`; both require the
native artifact build ID and the status of the actually loaded bundle. Use
Android's SDK configuration at `start`, or iOS's `setReleaseHealth` API. Keep build
IDs exact: a downloaded update is not a loaded bundle.

## Sessions and identity

The `launch-v1` session policy counts one native process lifetime or web document
lifetime observed by the SDK. Reinitializing the SDK, restoring a page from BFCache
or changing the loaded OTA bundle creates a new immutable segment within the same
launch. A new process/document gets a new launch ID. This is a launch session, not
a foreground engagement session. A session can appear in several build cohorts;
session and user counts must not be added across cohorts. Reporting windows select
segments by their start time, then deduplicate launches within each cohort.

Subjects are anonymous by default. Only the explicit release-health `userId`
produces an identified subject. `setUser`, verified identity, email, display name,
reporter, installation and device identifiers are never copied implicitly.
Supplied IDs must be nonblank, at most 128 UTF-16 units and contain no U+0000–U+001F control
characters or invalid surrogate sequences. They are self-declared opaque IDs,
not verified accounts; avoid emails and other direct personal information.
An invalid ID records nothing: web and React release health is unavailable for
that initialization or mount (web diagnostics say so), Android release health
does not become ready, and iOS's `ReleaseHealthConfiguration` initializer throws
`invalidUserIdentity`.

The ID and build are frozen before durable admission. On login, logout, account
switch or loaded-bundle change, reconfigure/reinitialize release health with the
new values (omit userId on logout). On web, use `destroy()` and a new `init()`;
on React, remount the Provider; on Android, call `Everframe.start` again with a
copied `ReleaseHealthConfig` (a full SDK restart); on iOS, call `setReleaseHealth`
with a new configuration. Calling `setUser` alone does not change this
separate identity. Queued starts and ends retain the old snapshot and route.
Native fatal attribution uses the exact frozen segment pointer, so a crash
recovered after login is not assigned to the newly logged-in account.

Reported session/user fractions mean **without a reported fatal crash** in the
current retained observations. They do not mean confirmed healthy sessions or
population crash-free rates. Missing outcomes remain unknown; neither an end nor
its absence proves a healthy/crashed process. Duplicates are deduplicated, while
late reports, retention and erasure can change the current counts. Anonymous
subjects never become synthetic users. Web terminal attribution is unsupported,
so web fatal fractions remain unavailable even when session counts exist.

## Durable delivery and privacy

A web start is committed to IndexedDB before its exposure token becomes available.
Records survive reload and retain their original build, subject and credential
route. The queue holds at most256 records/1MiB for7days. A full queue refuses the
new start, reports capacity and loss diagnostics and keeps draining older records.
Unavailable storage has no silent in-memory fallback. Requests time out after10s
and retry on init, an online event or explicit `flush()`.

Web `destroy()` and `pagehide` attempt to persist an end boundary. BFCache restore
opens a new segment; visibility changes alone do not. Browser termination can
interrupt asynchronous writes. Native producers likewise persist their start
before exposing a pointer and retain their frozen records for offline delivery;
their queue-loss accounting remains unavailable.

Web `kill()`, `disabled:true` and explicit `releaseHealth.enabled:false` revoke the
credential route and erase its queued records. Native disabling uses the SDK's
existing release-health consent boundary. Requests already sent cannot reliably
be recalled. Normal teardown preserves queued delivery. Other SDK keys/endpoints
do not drain under new credentials; old-key rows remain until expiry or explicit
erasure under the old route. A persisted generation prevents revoked pending work
from resuming.

If web storage rejects erasure, the document keeps a revocation barrier until the
purge succeeds. If the document exits while all persistent writes fail, it cannot
retain that intent; preserve the disabled preference across future loads until
storage recovers. Diagnostics expose the unavailable state. SDK opt-in, missing
outcomes, queue losses and offline expiry keep population coverage incomplete at
any volume; these observations alone do not enable health-rate alerts.
