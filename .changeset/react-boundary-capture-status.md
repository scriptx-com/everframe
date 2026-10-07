---
"@everframe/react-native": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Add `captureReactError` at `@everframe/react-native/integrations/react` for an existing React error boundary's `componentDidCatch`. It reports the caught error as a handled exception with bounded, redacted component-stack metadata and shares accepted error identity with `captureException` and automatic capture. Render the boundary inside `EverframeProvider`: a boundary that wraps the provider, or an error caught during the provider's first commit, is not captured. The subpath is native-only; browser-conditioned resolution rejects it.

Add `getErrorCaptureStatus()`, a detached, content-free snapshot of local JavaScript capture admission for the `handled`, `errorUtils` and `rejection` paths: attempts and their outcomes. `accepted` means the native SDK accepted the capture, not that the report was delivered. The browser entry returns `unsupported`.
