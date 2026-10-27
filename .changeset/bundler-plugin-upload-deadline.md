---
'@everframe/bundler-plugin': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

The source-map upload has an overall time limit, 10 minutes by default and set with the new `uploadTimeoutMs` option. At the limit, requests in flight are aborted and the upload fails. Before, the plugin set no limit, so a stalled server or retry backoff could keep the build running indefinitely.
