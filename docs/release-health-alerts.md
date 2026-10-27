<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Release health alerts

Each project can have one release health alert, such as "Alert when a version
drops below 99% crash-free sessions". Admins set it up on the project's
**Release health** page and choose:

- the target, from 50% to 99.9% in steps of 0.1 (99% by default);
- the minimum number of completed or crashed sessions a version needs in the
  last 7 days before it can alert, from 20 to 1,000,000 (100 by default);
- the webhook endpoint to send to, from any app in the project.

Everframe checks the rule about every five minutes, for every release of the
project's Android, iOS, React Native, web and React apps. A release alerts when
all its platforms counted together drop below the target, or when any one
platform does with at least the minimum number of sessions of its own. It then
sends one
`release_health.threshold_reached` webhook with event schema 2.1, over the
normal signed webhook transport. `ReleaseHealthThresholdEventSchema` in
`packages/protocol/src/release-health-alert.ts` is the exact shape, and every
event is checked against it before it is sent.

The rate is the one the release health page shows; see
[what a crash-free session is](release-health.md#what-a-crash-free-session-is).

Web sessions join existing rules automatically, using the same thresholds and
minimum resolved-session count. No new opt-in is needed. Unknown page outcomes
do not enter the rate. As with native alerts, sending requires a retained crash
report: if the detailed report was not delivered or was erased, the rate can be
below target while notification waits for a report. Health counts themselves do
not depend on the detailed report upload.

## Payload

```json
{
  "id": "28c4a9ef-855f-47fc-a903-f4dc7dbe424a",
  "type": "release_health.threshold_reached",
  "schemaVersion": "2.1",
  "createdAt": "2026-10-09T00:00:05.000Z",
  "data": {
    "projectId": "6f1c0b52-3d4e-4a8b-9c2d-7e5f6a1b2c3d",
    "ruleId": "b7e2d9a4-1c3f-4e5a-8b6d-9f0a1b2c3d4e",
    "version": "2.4.0",
    "platforms": ["android", "ios"],
    "belowTargetPlatforms": [],
    "window": { "days": 7, "from": "2026-10-02T00:00:00.000Z", "to": "2026-10-09T00:00:00.000Z" },
    "observedAt": "2026-10-09T00:00:00.000Z",
    "target": { "basisPoints": 9900, "minSessions": 100 },
    "sessions": { "total": 420, "completed": 400, "crashed": 8, "unknown": 12 },
    "crashFreeSessions": 0.9803921568627451
  }
}
```

Everything except `id`, `type`, `schemaVersion` and `createdAt` is in `data`.

- `id` is the notification UUID of one alert episode, and `createdAt` is when
  that notification was created.
- `projectId` and `ruleId` name the project and its rule.
- `version` is the app version, 1 to 64 UTF-16 code units, exactly as the SDKs
  read it; see [versions and builds](release-health.md#versions-and-builds).
- `platforms` lists the sorted, unique platforms the release page shows for the
  window: `android`, `ios`, `roku`, `tvos`, `web`, `tizen`, `webos`, `vega`,
  `vidaa`, `titanos`, `xbox`.
  React Native apps count under their native platform; React uses the web runtime.
- `belowTargetPlatforms` lists, sorted by `platform`, each platform that is below
  the target on its own, with its `sessions` and `crashFreeSessions` (same
  meaning as the totals). The event is sent when the total or any platform
  reaches the minimum and is below target; the list is empty only when the total
  itself is below target.
- `window` covers sessions that started at or after `from` and at or before `to`
  and that Everframe still keeps. `days` is always 7, and `to` equals
  `observedAt`.
- `observedAt` is when the counts were read.
- `target` is the rule: `basisPoints` from 5000 to 9990 in steps of 10 (9900
  means 99%), and `minSessions` from 20 to 1,000,000.
- `sessions` counts this version's sessions in the window across the project's
  apps, where `completed + crashed + unknown = total`.
- `crashFreeSessions` is `completed / (completed + crashed)`, from 0 to 1.
  Sessions with an unknown outcome are left out.

The event names no app, device, user or session, and carries no report body or
attachment URL.

## When an event is sent

A version is below the target when, in integer arithmetic:

- `completed + crashed >= minSessions`, and
- `completed * 10000 < (completed + crashed) * basisPoints`.

A rate exactly at the target is not below it: 99 completed and 1 crashed
against 99% gives 990,000, which is not less than 990,000. In the example
above, 400 × 10,000 = 4,000,000 is less than 408 × 9,900 = 4,039,200.

Each version has its own episodes. An evaluation that finds a version below the
target starts an episode, and sends one new event, when all of these hold:

- no episode of that version is open;
- no event for that version was created in the previous 24 hours, even one that
  was cancelled;
- the endpoint is enabled and its app is still in the project;
- Everframe still has a crash report from one of its crashed sessions in the
  last 7 days. The event is stored with that report, preferring one from the
  endpoint's own app.

While the episode is open, no further event is sent for that version. The
episode closes when an evaluation finds the version at or above the target with
at least `minSessions` completed or crashed sessions, or finds no sessions of
the version in the last 7 days. An evaluation that finds too few sessions
leaves it as it is. Versions alert independently, each with its own 24-hour
cooldown.

Editing the rule (its target, minimum or endpoint, or turning alerts off)
closes every open episode and cancels events not yet delivered. Each version's
24-hour cooldown survives the edit, so an edit never makes a version send a
second event within 24 hours. Deleting the rule removes its undelivered events.
Deleting the webhook endpoint the rule sends to deletes the rule too.

## Retries and cancellations

Deduplicate by `id`. Retries keep `id` and `createdAt`, but Everframe rechecks
the release before every attempt, so `platforms`, `belowTargetPlatforms`,
`window`, `observedAt`, `sessions` and `crashFreeSessions` can change between
attempts. Don't assume
byte-identical retry bodies.

An undelivered event is cancelled, and never sent, when:

- neither the release nor any of its platforms is below the target when it is
  rechecked;
- the rule was edited, turned off or deleted after the event was created;
- the endpoint was disabled, or its app moved to another project;
- the crash report it is stored with expired, was erased, or its app moved to
  another project;
- it was still not delivered 30 days after it was created;
- the organization was suspended;
- the counts stayed unreadable for an hour.

A cancellation closes that version's episode without meaning the version
recovered. A later evaluation that still finds it below the target can send
again, with a new `id`, once the 24-hour cooldown allows. An event that your
endpoint rejects, or whose retries all fail, is not cancelled: its episode
stays open, and no new event is sent for that version until the episode closes.

There is no recovery event. A version can stop being below the target because
more sessions arrive, or because sessions expire or are erased. Neither means
the release recovered.

## Receiving the event

- Later `2.x` versions only add fields; a change that could break a `2.x`
  receiver needs a new major version. Ignore fields you don't recognize and
  accept any `2.x` `schemaVersion`.
- Don't use the strict schema to reject deliveries. A 4xx response other than
  408 or 429 is a permanent failure that is not retried. The schema compares
  `crashFreeSessions` with the session counts by exact floating-point equality,
  so a valid event whose rate a parser rounded fails it. Base your own checks on
  the integer `sessions`.
- Schema 2.0 replaces 1.2 for this event type only. The 1.2 alerts, which each
  named one app and one build, are no longer sent. Every other webhook event
  stays at schema 1.2. Choose an endpoint that accepts this event type, since a
  4xx response to an unknown type fails the same way.
