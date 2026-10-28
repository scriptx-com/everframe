---
'@everframe/react-native': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

`captureException(error, { componentStack })` takes React's component stack from an app's own error boundary (`info.componentStack` in `componentDidCatch`; `null` is ignored). It goes under the error's message, as it already does for errors no boundary catches, so the dashboard can say which components an error happened in.
