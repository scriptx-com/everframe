<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# TraceItX SDKs

Public source, examples, and release artifacts for the TraceItX reporting and
session-evidence SDKs.

## Packages

- `@traceitx/web`
- `@traceitx/react`
- `@traceitx/react-native`
- Android SDK
- Apple SDK for iOS and tvOS
- Shared protocol, SDK core, identity helper, and display-name tooling

Customer-facing sample applications live in [`examples`](examples). The tvOS
sample includes a credential-free remote-focus smoke test.

## Development

Requirements vary by platform. JavaScript development requires Node 22 and
pnpm 9. Android development requires a compatible JDK and Android SDK. Apple
development requires Xcode.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check:boundary
pnpm build
pnpm test
pnpm typecheck
```

To run examples against your own TraceItX project:

```sh
cp .env.example .env
```

Fill only the SDK keys needed by the examples you run. `.env` and generated
platform configuration files are ignored by Git.

## Apple binary releases

The repository root [`Package.swift`](Package.swift) remains the binary SwiftPM
manifest used by tagged releases. Source development uses
[`packages/sdk-ios/Package.swift`](packages/sdk-ios/Package.swift).

## Security

Never commit credentials or production SDK keys. See [`SECURITY.md`](SECURITY.md)
for reporting instructions and the repository publication gates.

## License

ScriptX-owned source is available under the MIT License. Bundled upstream files
retain their original licenses; see `LICENSES` and `.reuse/dep5`.
