---
"@everframe/react": patch
"@everframe/web": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

React: an error that no error boundary inside `EverframeProvider` catches (thrown while rendering, in an effect or in a lifecycle method) is now reported as a fatal crash (`source: 'crash'`, `fatal: true`, mechanism `onerror`) with React's component stack after the message, `This error is located at:`. No error boundary is needed. Before, nothing was sent: React unmounts the whole tree, the provider included, in the same commit that reports the error, and the provider's unmount discarded the report while it was still being saved. A provider unmount now only stops new capture; a crash report already accepted is still saved and sent, and a failed send goes out on the next page load. Only `kill()` (and `destroy()`) still cancel it. The provider then hands the same error on, so an error boundary around the provider still catches it, and otherwise React reports it to the page as before; that second sighting is not reported again. Errors that a boundary inside the provider catches are unchanged. A React 18 development build reports a failed render or effect to `window.onerror` before any boundary sees it, so in development such an error can still arrive as a non-fatal error, instead of or as well as the fatal report.
