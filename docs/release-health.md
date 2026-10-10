<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Release health observations

Web, React, Android and iOS can collect release observations independently of
replay and playback vitals. Collection is opt-in. Web and React emit version 2
records with the `launch-v1` session policy. Android and iOS emit version 3 records
with the `foreground-v1` policy; the receiving service must support version 3
before you enable these SDK versions. Records queued locally by an earlier SDK
keep their original schema version and remain deliverable after upgrade.

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
Android's SDK configuration at `start`, or iOS's `setReleaseHealth` API. React
Native apps opt in with the Provider's `releaseHealth` configuration, which drives
these native sessions; see the
[React Native SDK](../packages/sdk-react-native/README.md#foreground-session-monitoring).
Keep build IDs exact: a downloaded update is not a loaded bundle.

## Sessions and identity

Web and React use the `launch-v1` policy: one web document lifetime observed by
the SDK. Reinitializing the SDK, restoring a page from BFCache or changing the
loaded bundle creates a new immutable segment within the same launch; a new
document gets a new launch ID. Earlier Android and iOS SDKs also used `launch-v1`,
observing one native process lifetime.

Android and iOS use the `foreground-v1` policy. A session starts durably only while
the app is in foreground, with a new exposure ID. Entering background closes it
with `outcome: completed` and `endReason: background`; reconfiguring release health
with a new user ID or loaded bundle closes it with `endReason: sdk_stop` and, while
in foreground, opens a new one. A completed end marks the end of foreground
monitoring, not a healthy process termination; process death leaves the outcome
unknown. Sessions of one process share its launch ID. A launch that never reaches
the foreground opens no session.

A launch can appear in several build cohorts; session and user counts must not be
added across cohorts. Reporting windows select segments and sessions by their start
time. Launch counts deduplicate both policies by launch ID within each cohort, so
several foreground sessions of one process count as one launch.

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
with a new configuration; on React Native, remount the Provider with a changed
`key`. Calling `setUser` alone does not change this
separate identity. Queued starts and ends retain the old snapshot and route.
Native fatal attribution uses the exact frozen pointer of its segment or session,
so a crash recovered after login is not assigned to the newly logged-in account.

Reported session/user fractions mean **without a reported fatal crash** in the
current retained observations. They do not mean confirmed healthy sessions or
population crash-free rates. Only crashes that carry the exact frozen pointer
count as fatal: iOS native crash reports, Android OS crash exit records (native or
Java), Android SDK crash reports from the JVM uncaught-exception handler or the
native signal handler, and the React Native JavaScript fatal reports described
below. A launch ended by an ANR or another OS exit counts as
without a reported fatal crash. So does an iOS foreground termination that the SDK
infers on the next launch (low memory, unresponsive or unexplained, labelled
inferred): it links to its exact frozen pointer as an other exit and never lowers
the crash-free rate. tvOS has no release-health sessions. Missing outcomes remain unknown; neither an end nor
its absence proves a healthy/crashed process. Duplicates are deduplicated, while
late reports, retention and erasure can change the current counts. Anonymous
subjects never become synthetic users. Web terminal attribution is unsupported,
so web fatal fractions remain unavailable even when session counts exist.

Version 3 producers attach no session pointer while the app is in background, so a
crash in background is outside the foreground session rates and does not make its
launch fatal; version 2 native producers attributed it to their launch segment.

React Native sessions come from the native Android and iOS producers and form
separate Android and iOS cohorts. An automatic unhandled JavaScript fatal from the
SDK's Hermes `ErrorUtils` handler carries the session pointer, and counts as a
fatal session, only when it is captured while the session is ready and its bundle
exactly matches the session's known loaded build. Handled errors and promise
rejections never carry a pointer. Fatals captured in background or before
readiness, and fatals with a missing or mismatched bundle identity, carry none
either; a foreground session that such a fatal ends keeps an unknown outcome. On
Android, OS exit records are reported only for native crashes and ANRs, so the
exit record of a process that React Native ends after a JavaScript fatal counts
only when that exit is a native crash. When a session has both a JavaScript fatal
and native or Java crash evidence, it is classified by the native or Java
evidence, and the session and its launch still count once.

Android and iOS foreground sessions also have resolved crash-free rates. They count
only sessions with a completed end or qualifying fatal evidence and report the rest
as missing outcome coverage. They cover observed, opted-in foreground sessions
only and are not population crash-free rates.

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
any volume, so these observations do not provide population crash-free rates.
Configured crash-free target alerts are a separate check on retained Android and
iOS foreground evidence that counts unknown outcomes as healthy; see
[foreground crash-free target webhooks](release-health-rate-alerts.md).
