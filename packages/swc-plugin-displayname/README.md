<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @traceitx/swc-plugin-displayname

> Preserves React component `displayName` through production minification — required for AI-readable TraceItX reports. SWC variant of [`@traceitx/babel-plugin-displayname`](../babel-plugin-displayname).

**License:** MIT

## Why

When SWC + terser/swc-minify minifies your bundle, component identifiers like `Foo` become `v3` or `t`. TraceItX resolves the focused element back to its component name by reading whatever names exist on the DOM at report time — without `displayName` baked in, every report points at `<v3 />` gibberish.

This plugin walks the SWC AST in Rust → WASM and inserts `Foo.displayName = "Foo"` after every `const Foo = forwardRef(...)`, `const Foo = memo(...)`, `const Foo = memo(forwardRef(...))`, and `function Foo() {}` (uppercase-leading).

## Install

```bash
pnpm add -D @traceitx/swc-plugin-displayname
```

Requires `@swc/core@>=1.15.0` (forward-compatible Wasm plugin cutoff per [SWC blog 2025-11-04](https://blog.swc.rs/2025-11-4-wasm-backward-compatibility)).

## Use

### Standalone @swc/core

```js
const wasmPath = require('@traceitx/swc-plugin-displayname').wasmPath;

await swc.transform(code, {
  jsc: {
    experimental: { plugins: [[wasmPath, {}]] },
  },
});
```

### Next.js (.swcrc / next.config.js)

```json
{
  "jsc": {
    "experimental": {
      "plugins": [["@traceitx/swc-plugin-displayname/swc_plugin_displayname.wasm", {}]]
    }
  }
}
```

Or in `next.config.js` via `experimental.swcPlugins` (Next.js 13+):

```js
module.exports = {
  experimental: {
    swcPlugins: [
      ['@traceitx/swc-plugin-displayname/swc_plugin_displayname.wasm', {}],
    ],
  },
};
```

### React Native (Metro + SWC)

If you've configured Metro with `@rnx-kit/metro-swc-worker` or similar, point its `experimental.plugins` at our WASM path identically.

## Behavior parity with Babel plugin

This plugin implements the same case table as `@traceitx/babel-plugin-displayname`. See `__tests__/fixtures/displayname-cases.md` (in the babel package) for the canonical list. CI runs both plugins against the same fixture set and asserts equivalent outputs survive minification.

## Building from source

Requires Rust toolchain + `wasm32-wasip1` target:

```bash
rustup target add wasm32-wasip1
node build-wasm.mjs
```
