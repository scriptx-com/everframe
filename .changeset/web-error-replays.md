---
"@everframe/web": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Errors now carry a session replay when the page is recording one. This covers `window.onerror`, unhandled rejections, `captureException` and React render errors that no error boundary caught. The replay covers the app's replay duration up to the error and is the same rrweb attachment bug reports use. Taking it does not stop or reset recording. At most 2 errors per page load get a replay. None is taken while the bug reporter is open, or in browsers without `CompressionStream`, and the error waits at most 3 seconds for it. A replay over 8,000,000 bytes, or one not ready in time, is left out and the error is flagged `replayOmitted`. Replay stays off unless the app turns it on, and the existing sampling rate applies.
