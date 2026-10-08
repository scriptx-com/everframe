<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
# Installed recovered-stall fixture

This credential-free API26+ host consumes the actual SDK Release Maven artifacts and minifies its own Release APK. Publish the SDK into an isolated Maven repository, then run the SDK Gradle wrapper against this directory with `-PeverframeMavenRepo=<absolute path>`, `-PeverframeVersion=<local version>` and `:app:assembleRelease`. Use `-PproofApplicationId=<unique owned package>`.

Before launching on a rootable owned emulator, block IPv4 and IPv6 output for only this package UID. Keep those rules until fixture cleanup; the ordinary SDK destination remains production and no production credentials are used. Never apply rules to unrelated packages.

Launch `.MainActivity` with string extras `mode`/`marker` and optional boolean `enabled` (default true). Poll `files/proof/<marker>.armed.json` before driving an external transition and `<marker>.json` for completion. Modes `observe`, `disabled` and `background` block the real main thread for6.5 seconds; only eligible recovered observation should enqueue evidence. `terminate` blocks for120 seconds so the harness can stop this unique process before acknowledgement; a later disabled `collect` must not infer a report from the missing heartbeat. `collect` preserves/export outbox entries. `drain503`/`drain200` use the real multipart uploader with an application interceptor, retaining transport bytes and returning the selected status. This proves immutable offline retry, not external network delivery.

`measure` and `measure-background` record30-second process CPU, PSS and private-file byte windows after warmup. Compare repeated enabled/disabled windows on the same device and record the emulator/OS/build. These observations do not qualify physical-device battery cost or all scheduler/debugger conditions. An OS ANR dialog is neither required nor evidence for this recovered-only mode.
