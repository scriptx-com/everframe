<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Contributing

Thanks for contributing to the Everframe SDKs and examples.

## Local checks

Use Node.js 22 and pnpm 9.15.0, then run:

```sh
pnpm install --frozen-lockfile
pnpm format:check
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

## Formatting

Run `pnpm format` to format supported source, styles, configuration, and documentation.
`pnpm format:check` checks formatting without rewriting files; it runs in the
Formatting CI workflow on pull requests and pushes to main, and through `pnpm lint`.
Both CI and local commands use the exact Prettier version in the root package manifest.

The baseline uses two spaces, single quotes, and a 100-column print width.
`.prettierignore` excludes generated outputs, dependency locks, upstream code,
fixtures, snapshots, and local/build files. Do not format those artifacts by hand.
Native Swift, Kotlin, Dart, C/C++, and shell files are outside Prettier's supported
languages and retain their existing checks. Type-checking remains a separate gate.
