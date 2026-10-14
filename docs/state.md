<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# React Native state

Attach small diagnostic labels to React Native reports on iOS and Android:

```tsx
import { setState, clearState } from '@everframe/react-native';

setState('plan', 'premium');
setState('subtitles.enabled', false);
setState('retry.count', 0);
clearState('plan');
```

Call these functions after `EverframeProvider` mounts, or use the same methods on
`useEverframe()`. Calls without a mounted provider are safe no-ops. Native updates
are synchronous: an immediately following JavaScript fatal-error capture observes
an accepted update. Duplicate values produce no history entry. Empty strings,
`false`, and `0` are values; `clearState` deletes a key. Invalid or over-budget
updates leave the previous value unchanged.

State belongs to the configured SDK session. Reconfiguration and kill clear it.
Explicit verified-identity sign-out clears custom state and invalidates pending
state snapshots. Publish your app's current labels again after these boundaries.
Changing a declared user label does not establish a new session or verify login.
Automatic `user.status` describes the declared user as `identified` or `anonymous`.

Manual reports freeze state when the reporter opens. Later app changes cannot
change that report. Cancelling the reporter keeps live state. Error reports take
a snapshot at capture. Queued reports keep their encoded evidence across retries.

Native fatal recovery carries the last successfully persisted observation from
the crashed process. Healthy-process refreshes are coalesced and best effort;
`capturedAt` is the observation time, which can precede the crash. Recovery never
uses the next launch's state. If the bounded native recovery context cannot hold
optional state, crash recording continues without it.

## Limits and privacy

Use stable labels such as feature flags, playback mode, or a plan category. Do not
send personal data, secrets, tokens, free-form user input, or dynamic identifiers.
State uses existing SDK redaction before retention, plus server-side masking.
Sensitive key values are replaced with `[REDACTED]`; labels that themselves need
redaction are dropped to avoid merging unrelated keys.

- Values: strings, finite numbers, or booleans. Objects, arrays, null and undefined
  are rejected. Strings are limited to 256 UTF-16 code units.
- Keys: nonempty, at most 64 UTF-16 code units, without control characters or
  unpaired surrogates. The reserved key `__proto__` is rejected.
- At most 50 distinct custom keys per session, including keys later cleared.
- At most 8 KiB of encoded live custom values and 32 KiB of encoded state.
- At most 100 changes. Earlier history is compacted into a checkpoint; the
  session's initial snapshot and an omitted-change count remain available.

Automatic state is separate from custom labels. It observes app version/build,
OS/version, locale, declared-user status, network type, and camera, microphone and
notification permission status. It does not prompt for permissions or add Android
manifest permissions. Unavailable facts stay `unknown` or `not-supported`.

The dashboard shows typed captured values, initial state, the checkpoint and
changes alongside breadcrumbs. State row times can seek a report's replay.
The Reports filter accepts a key and an exact string, number or boolean value:
`false` differs from `"false"`. Cleared or absent keys do not match. Expired and
erased evidence is excluded from state filtering and report/MCP reads.

This delivery supports React Native mobile. Web/React, Flutter, KMP, Roku, Vega,
standalone native applications and television targets need separate qualification.
