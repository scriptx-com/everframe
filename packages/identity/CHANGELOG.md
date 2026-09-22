<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @traceitx/identity

## 0.2.0

### Minor Changes

- 8e53a03: Add `@traceitx/identity` — mint TraceItX identity tokens from any runtime with
  one `createIdentityHandler({ secret, projectId, resolveUser })` call, plus the
  `identity={{ endpoint, key }}` prop on `TraceItXProvider` that replaces the
  hand-written `setIdentityToken` effect. `headers` is re-invoked on every mint,
  so rotating access tokens work; cookies are no longer assumed.
