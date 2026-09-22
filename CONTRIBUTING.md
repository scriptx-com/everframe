<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Contributing

Thanks for contributing to the TraceItX SDKs and examples.

## Local checks

Use Node.js 22 and pnpm 9.15.0, then run:

```sh
pnpm install --frozen-lockfile
pnpm test:boundary
pnpm check:boundary
pnpm build:packages
pnpm test:packages
pnpm typecheck:packages
```

Android development uses the Gradle wrapper in `packages/sdk-android/android`.
Apple development uses the Swift package in `packages/sdk-ios`. The public tvOS
sample is credential-free and lives in `examples/tvos-replay`.

Every contributed source file must carry an MIT SPDX header. Files copied from
upstream projects must retain their original license. Run `reuse lint` before
opening a pull request.

Please keep pull requests focused, explain observable behavior changes, and add
or update tests for fixes and new behavior.

