<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @traceitx/sdk-core

Shared, platform-independent TypeScript runtime for the TraceItX SDKs.

This package contains the reporting behavior used by the public web and React
integrations. It is intentionally kept separate from browser capture and UI so
the same rules can be tested once and applied consistently across hosts.

`@traceitx/sdk-core` is currently a private workspace package and is not meant
to be installed directly by applications. Choose
[`@traceitx/web`](../sdk-web/README.md),
[`@traceitx/react`](../sdk-react/README.md), or
[`@traceitx/react-native`](../sdk-react-native/README.md) for an application
integration.

## Responsibilities

- Client lifecycle and remotely supplied SDK configuration
- Report-envelope construction using [`@traceitx/protocol`](../protocol)
- Redaction, field budgets, compression, and multipart transport
- Breadcrumb, log, network-body, replay, and outbox primitives
- User projection, identity tokens, reporter threads, and replies
- Handled-error capture, fingerprinting, throttling, and cause chains
- Session-vitals collection and player-integration contracts

Platform packages provide the environment-specific capture adapters, storage,
triggers, and reporter UI. The core does not access the DOM or native platform
APIs directly.

## Development

From the repository root:

```sh
pnpm --filter @traceitx/sdk-core build
pnpm --filter @traceitx/sdk-core test
pnpm --filter @traceitx/sdk-core typecheck
pnpm --filter @traceitx/sdk-core check:publish
```

The protocol package must be built before SDK Core when running package tools
outside the root Turbo pipeline. `pnpm build:packages` handles that dependency
order automatically.

## License

MIT
