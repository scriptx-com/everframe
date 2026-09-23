<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe SDKs

The open-source home of the Everframe reporting SDKs, shared protocol and SDK
core, developer tooling, and sample applications.

[Everframe](https://everframe.dev) helps users report problems from inside an
application with the context needed to reproduce them: screenshots and
annotations, session evidence, breadcrumbs, device and application metadata,
and captured errors.

## Choose an SDK

| Platform | SDK | Documentation | Examples |
| --- | --- | --- | --- |
| Web and framework-agnostic JavaScript | [`@everframe/web`](https://www.npmjs.com/package/@everframe/web) | [Web SDK](packages/sdk-web/README.md) | [Vue](examples/vue-web), [Smart TV](examples/smarttv-tester) |
| React | [`@everframe/react`](https://www.npmjs.com/package/@everframe/react) | [React SDK](packages/sdk-react/README.md) | [React web](examples/react-web) |
| React Native, Apple TV, and Android TV | [`@everframe/react-native`](https://www.npmjs.com/package/@everframe/react-native) | [React Native SDK](packages/sdk-react-native/README.md) | [React Native](examples/react-native), [React TV](examples/react-tv-sample) |
| Android and Android TV | `com.traceitx` Maven modules | [Android SDK](packages/sdk-android/README.md) | [Compose](examples/android-compose), [Views](examples/android-views) |
| iOS, iPadOS, and tvOS | `TraceItX` Swift package | [Apple SDK](packages/sdk-ios/README.md) | [iOS](examples/ios-native), [tvOS replay](examples/tvos-replay) |
| Server-side identity | [`@everframe/identity`](https://www.npmjs.com/package/@everframe/identity) | [Identity helper](packages/identity/README.md) | Runtime-specific recipes are included in the package documentation |

Each SDK README is the canonical guide for installation, configuration,
privacy controls, platform support, and current limitations.

## Shared packages and tooling

- [`@everframe/protocol`](packages/protocol/README.md) defines the versioned report
  envelope shared by every SDK and provides the generated JSON Schema used by
  the native implementations.
- [`@everframe/sdk-core`](packages/sdk-core/README.md) contains the platform-independent
  TypeScript reporting runtime and utilities shared by the Web, React, and React
  Native SDKs.
- The [Babel](packages/babel-plugin-displayname) and
  [SWC](packages/swc-plugin-displayname) plugins preserve React component names
  in optimized builds.
- [`packages/sdk-android`](packages/sdk-android) and
  [`packages/sdk-ios`](packages/sdk-ios) contain the native SDK source,
  platform tests, and publication tooling.

## Using the SDKs

Install the package for your application and follow its platform guide. For
JavaScript projects, for example:

```sh
pnpm add @everframe/web
# or
pnpm add @everframe/react
# or
pnpm add @everframe/react-native
```

The Android SDK is distributed as `com.traceitx` Maven modules through GitHub
Packages. Tagged Apple releases can be consumed with Swift Package Manager
from this repository. Their documentation contains the current coordinates,
products, and setup instructions.

## Examples

The [`examples`](examples) directory contains runnable hosts for the supported
platforms and integration styles:

| Example | Demonstrates |
| --- | --- |
| [`react-web`](examples/react-web) | React web integration and SSR/CSP fixtures |
| [`vue-web`](examples/vue-web) | Framework-agnostic SDK integration from Vue |
| [`smarttv-tester`](examples/smarttv-tester) | Browser-based Smart TV behavior |
| [`react-native`](examples/react-native) | React Native bridge integration |
| [`react-tv-sample`](examples/react-tv-sample) | React Native TV host integration |
| [`android-compose`](examples/android-compose) | Native Android with Jetpack Compose |
| [`android-views`](examples/android-views) | Native Android with the Views system |
| [`ios-native`](examples/ios-native) | Native iOS integration |
| [`tvos-replay`](examples/tvos-replay) | Credential-free tvOS replay and remote-focus smoke testing |

Examples that connect to Everframe read development credentials from generated,
ignored configuration. Start from the checked-in template:

```sh
cp .env.example .env
```

Fill only the values required by the example you are running. Never commit SDK
keys, identity secrets, generated platform configuration, or production data.

## Contributing

JavaScript development requires Node.js 22 and pnpm 9.15. Android development
also requires a compatible JDK and Android SDK; Apple development requires
Xcode.

```sh
git clone https://github.com/scriptx-com/everframe.git
cd everframe
corepack enable
pnpm install --frozen-lockfile
```

Run the same JavaScript workspace checks used by CI:

```sh
pnpm test:boundary
pnpm check:boundary
pnpm build:packages
pnpm test:packages
pnpm typecheck:packages
pnpm build:examples
pnpm test:examples
pnpm typecheck:examples
pnpm check:publish
```

Run native checks from their platform projects:

```sh
# Android
cd packages/sdk-android/android
./gradlew test assembleRelease

# Apple, from the repository root
TRACEITX_DEV_INGEST_URL=http://127.0.0.1:9 \
  swift test --package-path packages/sdk-ios
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution and licensing rules.

## Releases

JavaScript packages are published to npm, Android artifacts are published as
Maven packages, and tagged Apple releases provide binary XCFrameworks for
Swift Package Manager consumers.

The root [`Package.swift`](Package.swift) is the binary manifest used by Apple
SDK consumers. Source development and tests use
[`packages/sdk-ios/Package.swift`](packages/sdk-ios/Package.swift).

## Security

Please report vulnerabilities privately as described in
[`SECURITY.md`](SECURITY.md). The repository's publication gates check the
allowed public file boundary, SPDX metadata, committed content, and Git history
before release.

## License

ScriptX-owned source is available under the [MIT License](LICENSE). Bundled
upstream files retain their original licenses; see [`LICENSES`](LICENSES) and
[`REUSE.toml`](REUSE.toml).
