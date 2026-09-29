<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Roku crash lab

A test channel that triggers every Everframe Roku SDK scenario from the remote.
A list of scenarios, a status panel (library load status, SDK started, queued
records, last exit info, user, current screen, and the SDK's latest memory
reading), and one extra screen (row 10) for screen tracking. No content, no
video.

## Setup

1. **Enable developer mode** on the Roku: on the remote press Home three times,
   Up twice, Right, Left, Right, Left, Right. Note the device IP address and set
   the developer password.
2. **Create a Roku app** in the Everframe dashboard and copy its SDK key.
3. **Fill in the repo-root `.env`** (or export the variables in your shell;
   the process environment wins over the file):

   ```
   EVERFRAME_KEY_ROKU=<sdk key>
   ROKU_HOST=<roku ip>
   ROKU_DEV_PASSWORD=<developer password>
   # optional: an ingest URL the TV can reach over your LAN
   EVERFRAME_INGEST_URL=http://192.168.1.20:8787
   ```

   `ROKU_HOST` and `ROKU_DEV_PASSWORD` are not needed with `--no-deploy`. Set
   `EVERFRAME_ENV_FILE` to read a different env file.
4. Install dependencies with `pnpm install` from the repo root (pnpm 9).

## Run

```bash
pnpm --filter @everframe/example-roku run:roku            # build, instrument, sideload
pnpm --filter @everframe/example-roku run:roku -- --logs  # ...then stream the debug console
```

Flags:

| Flag | Effect |
|---|---|
| `--no-deploy` | Build and package only (`.build/everframe-crash-lab.zip`); do not sideload. `pnpm --filter @everframe/example-roku build:roku` is the same. |
| `--no-instrument` | Skip the `everframe-roku instrument` step (the SDK is still started, but there are no automatic wrappers). |
| `--remote-library <url>` | Load the SDK component library from an `http(s)` URL instead of bundling it in the channel. |
| `--logs` | After sideloading, stream the Roku debug console (`<ROKU_HOST>:8085`) to the terminal and to `.build/console.log`. Retries the connection for up to 15 s while the channel starts; Ctrl+C stops it. |

The script rebuilds `packages/sdk-roku` every run, so the channel always uses
the SDK in this workspace. Instrumentation excludes `components/Excluded.brs`
and `components/OomTask.brs` on purpose (see rows 6 and 7).

## Scenarios

Select a row with OK. "Relaunch" means press Home, then open the channel again
(or run `run:roku` again if the channel was killed). The SDK sends a persisted
crash on the launch after it happened.

"Path A" is the in-process try/catch wrapper that `everframe-roku instrument`
adds around your code; it reports a crash immediately. "exit-info" is
next-launch detection via `GetLastExitInfo` (Roku OS 13+), used when nothing
could catch the crash. Roku returns that record only to the channel's own
code, so the instrumented `Main()` stores it for the SDK before anything else
runs; the status panel's "SDK last handled exit" line shows the timestamp the
SDK processed (and notes when a recorded exit is still pending).

| # | Row | Press / relaunch | Expect in the dashboard | Proves |
|---|---|---|---|---|
| 1 | Crash: list selection (render thread) | OK on the row. The channel crashes; relaunch once. | A crash with the frame at the exact line and `threadName: render`. | Path A via an observer wrapper. |
| 2 | Crash: press ✱/options (options key) | OK on the row, then press `*` (options). Relaunch once. | A crash from `onKeyEvent`. The breadcrumb evidence is the options-key crumb (the list consumes navigation keys, so only the options key is recorded). | Path A via `onKeyEvent`; key-press breadcrumbs. |
| 3 | Crash: inside a Task | OK on the row. Relaunch once. | A crash with `threadName` = `CrashTask`. | Path A on a Task thread. |
| 4 | Crash: before the scene (next launch) | OK on the row (it arms a flag), then relaunch **twice**: the first relaunch crashes in `Main()`, the second sends the report. | A crash raised before any Everframe node exists. | Hook with no Everframe node: persisted from `Main()`, sent on the launch after. |
| 5 | Report handled error | OK on the row. No relaunch; the channel keeps running. | An error report with `source: error`. | `captureException`. |
| 6 | Crash: excluded file (next launch only) | Roku OS 13+. OK on the row; the channel crashes about 0.1 s later. Relaunch once. | A crash reconstructed from exit info, with the console log parsed. It carries the breadcrumbs left before the crash: run row 9 first and the report includes its `crash lab breadcrumb`, which the SDK persisted to the registry and attached on relaunch. | Not wrapped, so only the next-launch `exit-info` path runs, with `console_log` parsing. |
| 7 | Out of memory (in a Task) | Roku OS 13+. OK on the row; the OS kills the channel. Relaunch once. | An exit-info report with `EXIT_CHANNEL_MEM_LIMIT_FG` or `EXIT_OUT_OF_MEMORY`. It shows only via exit info because `OomTask.brs` is excluded from instrumentation. `details.metadata.memory` holds the last reading before the kill, and the breadcrumbs show memory climbing (`memory 75% of … MB`, 90 %, 95 %, and `memory warning from OS (NN%)` where the OS sends one). The SDK polls every 5 s, so if the allocation outruns a poll you see fewer steps; the status panel's `Memory:` line shows the live reading. | The out-of-memory exit code on the next launch. |
| 8 | Crash loop x4 | OK on the row (it crashes and arms a counter of 4). Relaunch until the status panel shows `0 left after this one`; after that crash, relaunch once more (the channel stays up) so the 4th record drains and is dropped by the guard. Each loop launch waits for the queue to drain before crashing (up to 15 s). | Exactly 3 loop reports for that fingerprint. The first crash (list selection) is a separate issue with a different fingerprint. | Crash-loop guard: at most 3 reports per fingerprint per hour. |
| 9 | Set user + add breadcrumbs | OK on the row, then trigger any crash (row 1 is easiest) and relaunch. | On that report: user id `"42"` (the numeric id 42 arrives as the string `"42"`), email `lab@example.com`, and a `crash lab breadcrumb` custom breadcrumb. | `setUser` with a numeric id sent as a string; custom breadcrumb on the next report. |
| 10 | Open details screen | OK on the row: the details screen opens and the status panel shows `Screen: DetailsScreen`. Press `*` (options) to crash, then relaunch once. (Back returns to the list and sets `Screen: Lab` again.) | A crash with `context.route: "DetailsScreen"` and a `navigation` breadcrumb `screen: DetailsScreen` with `data: { from: "Lab", to: "DetailsScreen" }`. Crashes from the list carry `context.route: "Lab"`. | Screen tracking both ways: `LabScene` calls `setScreen("Lab")` after `start()`; `DetailsScreen` is tracked by `everframe-roku instrument` because its name matches the default `--screens` pattern `*Screen` (so with `--no-instrument` it stays `Lab`). |

Running row 8 again within an hour yields 0 new loop reports (the guard is still
active). An abandoned loop self-drains after the remaining launches.

Rows 6 and 7 need `GetLastExitInfo`, which exists from Roku OS 13. On older
firmware they produce no exit-info report.

## Capturing the real crash console

The SDK's console-log parser is tested against a synthetic fixture. To replace
it with a real one:

1. Run with logs: `pnpm --filter @everframe/example-roku run:roku -- --logs`.
2. Trigger a crash (for example row 1).
3. Stop the stream with Ctrl+C, then copy the crash block (the backtrace
   printed by the OS) from `.build/console.log` into
   `packages/sdk-roku/__tests__/fixtures/console-crash.txt`.

## Troubleshooting

- **Status shows `Library: failed` or `loadStatus` failed**: the library URI is
  wrong, or the remote library URL is not reachable from the TV. Check the URI
  shown in the status panel; without `--remote-library` it is the bundled
  `pkg:/components/everframe-roku-<version>.zip`.
- **Queued records stay non-zero**: the SDK cannot reach ingest from the TV. If
  `EVERFRAME_INGEST_URL` points at `localhost`, `127.0.0.1`, `0.0.0.0` or
  `::1`, the script prints a warning on stderr: use your computer's LAN IP.
- **`401` from ingest**: the SDK key is wrong or belongs to a different app.
- **Sideload fails**: check `ROKU_HOST`, `ROKU_DEV_PASSWORD` and that developer
  mode is enabled.
- **`pnpm not found on PATH`**: install pnpm 9 (`corepack enable`).
