<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/bundler-plugin

Stamps an Everframe build identity into web bundles and uploads their source
maps at the end of each production build, so crashes from that build show
original source. `@everframe/web` and `@everframe/react` pick the identity up
automatically.

```sh
npm i -D @everframe/bundler-plugin
```

```ts
// vite.config.ts
import everframe from '@everframe/bundler-plugin/vite';

export default {
  plugins: [everframe({ appId: process.env.EVERFRAME_APP_ID })],
};
```

The other bundlers use the same options from their own subpath:

```ts
import everframe from '@everframe/bundler-plugin/webpack'; // plugins: [everframe({ appId })]
import everframe from '@everframe/bundler-plugin/rollup';  // plugins: [everframe({ appId })]
import everframe from '@everframe/bundler-plugin/esbuild'; // plugins: [everframe({ appId })]
```

For Next.js, wrap the config and build with webpack. Turbopack builds still
succeed but are not stamped or uploaded:

```ts
// next.config.ts
import { withEverframe } from '@everframe/bundler-plugin/next';

export default withEverframe({}, { appId: process.env.EVERFRAME_APP_ID });
```

```sh
next build --webpack
```

## Options

- `appId`: the Everframe application UUID. When it is missing or invalid, a
  local build prints a warning and the plugin does nothing; in CI (`CI=true`)
  the build fails.
- `buildId`: defaults to `EVERFRAME_BUILD_ID`, else a fresh UUID per build.
- `deleteAfterUpload`: removes the maps after upload so they are never
  deployed (default `true`).
- `apiUrl`: defaults to `EVERFRAME_API_URL`, else the production API,
  `https://everframe.dev/api/v1`.

Uploads need `EVERFRAME_API_TOKEN`, a token with the `artifacts:write` scope.
Without it a local build warns, skips the upload and still removes the maps
(unless `deleteAfterUpload` is `false`); a CI build fails.
