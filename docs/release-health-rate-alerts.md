<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Foreground crash-free target webhooks

`release_health.rate_threshold_reached` (event schema 1.2) reports that, in one
configured Android or iOS cohort, the crash-free share of observed foreground
sessions or identified users is below a configured target even when every
unknown outcome is counted as healthy. It uses the same signed webhook transport
as [fatal-session threshold webhooks](release-health-alerts.md).
`ReleaseHealthRateThresholdEventSchema` in
`packages/protocol/src/release-health-rate-alert.ts` is the exact 1.2 shape;
every event is checked against it before it is sent.

The receiver rules of the [fatal-session guide](release-health-alerts.md) apply:
ignore fields you do not recognize, accept any `1.x` `schemaVersion`, and do not
use the strict schema to reject deliveries, because a 4xx response other than
408 or 429 is a permanent failure that is not retried. This matters more here:
the schema compares `bounds` with the count ratios by exact floating-point
equality, so a valid event whose bounds a parser or serializer rounded (for
example to 15 significant digits) fails it. Base your own checks on the integer
`counts`. Each rule sends to one chosen endpoint; choose one that accepts this
event type, since a 4xx response to an unknown type fails the same way.

## Metrics and units

A rule selects one metric for one cohort and a 7 or 30 day rolling window:

- `foreground_crash_free_sessions` counts observed foreground sessions.
- `foreground_crash_free_users` counts identified users: distinct release-health
  `userId` values with at least one observed foreground session in the cohort
  and window. Anonymous sessions never become users.

Only `foreground-v1` session starts from version 3 Android and iOS producers are
observed; `launch-v1` segments are not part of these metrics. A session is fatal
when it carries qualifying fatal evidence (see
[release health observations](release-health.md)), completed when its end was
received with `outcome: completed` and it has no fatal evidence, and unknown
otherwise. A user is fatal if any of their sessions is fatal, completed if all
of them completed, and unknown otherwise. Counts describe one cohort; do not add
them across cohorts.

## Payload

```json
{
  "id": "bf31d743-998c-41f7-98a6-2a5e85e232b0",
  "type": "release_health.rate_threshold_reached",
  "schemaVersion": "1.2",
  "createdAt": "2026-10-09T12:00:00.000Z",
  "data": {
    "appId": "53143310-f812-4608-aa87-c4fd7c42f144",
    "projectId": "4ecc98c1-5405-4ddb-a811-6c7df66abb02",
    "ruleId": "6a00adb7-2b23-4fb1-80a0-84f33c53e87c",
    "metric": "foreground_crash_free_sessions",
    "cohort": { "platform": "android", "nativeBuildId": "release-42",
      "loadedBundleStatus": "not_applicable", "loadedBuildId": null },
    "window": { "days": 7, "from": "2026-10-02T12:00:02.000Z", "to": "2026-10-09T12:00:02.000Z" },
    "observedAt": "2026-10-09T12:00:02.000Z",
    "thresholds": { "minObserved": 100, "minFatal": 3, "targetBasisPoints": 9900,
      "minOutcomeCoverageBasisPoints": 9000, "minIdentityCoverageBasisPoints": 0 },
    "counts": { "observed": 1000, "completed": 960, "fatal": 25, "unknown": 15,
      "observedSessions": 1000, "identifiedSessions": 640, "conflictingSessions": 0 },
    "bounds": { "lower": 0.96, "upper": 0.975 },
    "coverage": { "policy": "foreground-v1", "population": "unknown",
      "accounting": "current_retained_evidence" }
  }
}
```

Everything except `id`, `type`, `schemaVersion` and `createdAt` is in `data`.

- `id` is the notification UUID of one alert episode, and `createdAt` is when
  that notification was created.
- `appId`, `projectId` and `ruleId` identify the rule; `metric` is one of the
  two metrics above.
- `cohort` is the same exact identity as in the fatal-session event: `platform`
  (`android` or `ios`), `nativeBuildId`, and `loadedBundleStatus` (`known` or
  `not_applicable`) with the matching `loadedBuildId` or `null`.
- `window` selects sessions that started at or after `from` and before `to` and
  are still retained. `to` equals `observedAt`, when the counts were read, and
  `from` is exactly `days` (7 or 30) earlier.
- `thresholds` is the rule's policy. `minObserved` (20 to 1,000,000) and
  `minFatal` (3 to 100,000) use the selected unit. `targetBasisPoints` (1 to
  10,000; 9900 means 99%) is the crash-free target and
  `minOutcomeCoverageBasisPoints` (8,000 to 10,000) the minimum outcome
  coverage. `minIdentityCoverageBasisPoints` is fixed: 8000 for users and 0 for
  sessions.
- `counts` holds `observed`, `completed`, `fatal` and `unknown` in the selected
  unit, where `completed + fatal + unknown = observed`. `observedSessions` and
  `identifiedSessions` always count the cohort's observed foreground sessions
  and those with a supplied user ID; for the sessions metric, `observed` equals
  `observedSessions`. `conflictingSessions` counts observed sessions whose exit
  evidence conflicts, such as two different crash kinds or a crash and an ANR;
  it is 0 in every sent event.
- `bounds` holds the crash-free bounds described below, from 0 to 1.
- `coverage` is always `policy: foreground-v1`, `population: unknown` and
  `accounting: current_retained_evidence`.

A users event has the same shape with `metric: foreground_crash_free_users` and
`minIdentityCoverageBasisPoints: 8000`; its `observed`, `completed`, `fatal` and
`unknown` count users, and `observed` is at most `identifiedSessions`.

## When an event is sent

For the selected unit, `bounds.lower = completed / observed` counts every
unknown outcome as a crash, and `bounds.upper = (completed + unknown) / observed`
counts every unknown outcome as healthy. The breach decision uses the upper
bound, so unknown outcomes count as healthy: an event is sent only when even the
upper bound is strictly below the target. Equality is not a breach. The
resolved-only rate `completed / (completed + fatal)` does not decide.

Every condition below must hold, in integer arithmetic, when the rule is
evaluated and again before each delivery attempt:

- volume: `observed >= minObserved` and `fatal >= minFatal`;
- outcome coverage, the share of units with a known outcome:
  `(completed + fatal) * 10000 >= observed * minOutcomeCoverageBasisPoints`;
- identity coverage, for the users metric only:
  `identifiedSessions * 10000 >= observedSessions * 8000`, so at least 80% of
  the observed foreground sessions carry a user ID;
- no conflicting evidence: `conflictingSessions = 0`;
- breach: `(completed + unknown) * 10000 < observed * targetBasisPoints`.

## Coverage and limits

`population: unknown` and `accounting: current_retained_evidence` mean that the
counts cover only observed, opted-in foreground sessions whose records are
currently retained. SDK opt-in, missing outcomes, queue losses, offline expiry,
retention and erasure keep population coverage unknown at any volume. The event
is not a population crash-free rate, a statistical regression or significance
result, a complete count of crashes, or a health verdict. It carries aggregate
counts only: no user or session IDs, report bodies or attachment URLs.

## Retries, episodes and recovery

Deduplicate by the top-level `id`. Retries keep that `id` and the original
`createdAt`, but the counts are recomputed and every condition is rechecked
before each attempt, so `counts`, `bounds`, `window` and `observedAt` can differ
between attempts. Do not assume byte-identical retry bodies.

Rules are evaluated about every five minutes. An episode starts, with a new
notification, when an evaluation meets every condition while the endpoint is
enabled, no episode of the rule is open and the rule has not notified in the
previous 24 hours. No further event is sent while the episode stays open. It
ends when an evaluation with enough observed units, sufficient coverage and no
conflicting evidence finds the target no longer breached or fewer than
`minFatal` fatal units; an evaluation that fails one of those three checks
leaves it open. Editing or disabling the rule also ends it and cancels its
queued notification.

An undelivered notification is cancelled, and never sent, if any condition
above fails when it is rechecked before an attempt, if the endpoint is disabled,
or if the app is out of the rule's scope, for example because it moved to
another project or its organization is suspended. It is also cancelled if the
retained crash report it is stored with expires or is erased, or if current
counts stay unreadable for an hour. A cancellation ends the episode without
signaling recovery, and a later evaluation that still meets the rule can notify
again, with a new `id`, once the 24-hour cooldown allows. A notification that
your endpoint rejects, or whose retries all fail, is not cancelled: its episode
stays open, and no new event is sent until the episode ends.

There is no recovery event. The target may stop being breached because records
expire or are erased, or because more sessions arrive; that does not establish
that a release recovered.
