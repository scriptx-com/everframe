---
'@everframe/web': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

`captureException(error, { componentStack })` takes React's component stack from an app's own error boundary (`info.componentStack` in `componentDidCatch`; `null` is ignored). It goes under the error's message, as it already does for errors the SDK's own boundary catches, so the dashboard can say which components an error happened in and map their names through the source map. Errors also record whether the browser had translated the page, the most common cause of React's `NotFoundError` from `removeChild` or `insertBefore`.
