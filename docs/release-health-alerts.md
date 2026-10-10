<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Reported fatal-session threshold webhooks

For alerts on a configured crash-free target for foreground sessions or
identified users, see [foreground crash-free target webhooks](release-health-rate-alerts.md).

`release_health.threshold_reached` (event schema 1.2) reports that one configured
native cohort crossed an observed-session and fatal-session count threshold. It
uses the normal signed webhook transport. `ReleaseHealthThresholdEventSchema` in
`packages/protocol/src/release-health-alert.ts` is the exact 1.2 shape; every
event is checked against it before it is sent.

Later `1.x` versions only add fields; a change that could break a `1.x` receiver
needs a new major version. Receivers should ignore fields they do not recognize
and accept any `1.x` `schemaVersion`. Do not use the strict 1.2 schema to reject
deliveries: a 4xx response other than 408 or 429 is a permanent failure, so a
rejected event is not retried.

The data contains app/project/rule IDs, exact native and loaded-bundle identity,
a 7 or 30 day rolling window of segment and session starts, observation time,
configured minimums, and counts of observed launches, launches with qualified fatal
evidence, and launches without qualified exit evidence. Only explicit starts
qualify: `launch-v1` segment starts from version 2 Android and iOS producers and
`foreground-v1` session starts from version 3 ones. Fatal evidence must be retained
and carry the exact frozen pointer. Counts deduplicate launches within each cohort,
so several foreground sessions of one launch count once; do not add counts across
cohorts.

Version 3 producers attach no session pointer while the app is in background. With
them, a launch that never reaches the foreground is not observed, and a crash in
background does not make its launch fatal; version 2 producers counted both. Keep
this in mind when comparing cohorts across that SDK upgrade.

React Native apps can configure rules for their Android or iOS cohorts.
An automatic unhandled Hermes JavaScript fatal counts as fatal evidence when it
carries the exact pointer of a ready session whose known loaded build matches the
fatal's bundle; handled errors, promise rejections and other JavaScript reports do
not count. A launch with both such a JavaScript fatal and native or Java crash
evidence counts once; see [release health observations](release-health.md).

Coverage is always `incomplete`, and the metric is `reported_fatal_sessions`.
This is not a population crash-free rate, statistical regression, complete count
of crashes, or health verdict. Missing outcomes must not be treated as successes.
No person identifiers, report bodies or attachment URLs are included.

Deduplicate by the top-level event `id`, a stable notification UUID for one
threshold episode. Retries use that same ID and original `createdAt`, but
revalidate current evidence before sending. Counts, `observedAt`, and window may
therefore change between attempts. Receivers should not assume byte-identical
retry bodies. Suppressed or invalidated episodes may never be delivered.

There is no recovery webhook. A threshold may cease to be met because records
expire or are erased; that does not establish that a release recovered.
