<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe Android SDK

Native Android SDK workspace for Everframe reporting, session evidence, and
playback diagnostics.

The implementation is a Gradle multi-module project under [`android`](android).
The [`package.json`](package.json) at this level is only a workspace marker: it
lets the repository-wide pnpm and Turbo commands invoke Gradle consistently.
Android applications consume the published `dev.everframe` Maven artifacts,
not the pnpm package.

See the [complete Android integration guide](android/README.md) for Maven
configuration, initialization, triggers, privacy controls, API usage, and
platform limitations.

## Modules

| Gradle module | Maven artifact | Purpose |
| --- | --- | --- |
| `everframe-protocol` | `dev.everframe:protocol` | Generated wire-protocol models |
| `everframe-core` | `dev.everframe:core` | Capture, envelope, transport, outbox, and SDK lifecycle |
| `everframe-reporter-ui` | `dev.everframe:reporter-ui` | Compose reporter and annotation UI |
| `everframe-media3` | `dev.everframe:media3` | Media3 and ExoPlayer session-vitals integration |
| `everframe-gradle-plugin` | Everframe Gradle plugin | Build integration and optimized-build metadata |

## Development

From the repository root, use the workspace scripts:

```sh
pnpm --filter @everframe/sdk-android build
pnpm --filter @everframe/sdk-android test
pnpm --filter @everframe/sdk-android publish:maven-local
```

Or run Gradle directly:

```sh
cd packages/sdk-android/android
./gradlew test assembleRelease
./gradlew publishAllToMavenLocal
```

The repository CI additionally verifies that every published Android module
contains real source and API-documentation artifacts.

## Examples

- [`examples/android-compose`](../../examples/android-compose) demonstrates a
  native Jetpack Compose host.
- [`examples/android-views`](../../examples/android-views) demonstrates the
  Android Views integration.

## License

MIT
