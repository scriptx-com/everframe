<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/babel-plugin-displayname

> Preserves React component `displayName` through production minification — required for AI-readable Everframe reports.

**License:** MIT

## Why

When Babel + terser/uglify minifies your bundle, component identifiers like `Foo` become `v3` or `t`. Everframe resolves the focused element back to its component name by reading whatever names exist on the DOM at report time — without `displayName` baked in, every report points at `<v3 />` gibberish, useless to an AI agent or human reviewer.

This plugin walks the AST and inserts `Foo.displayName = "Foo"` after every `const Foo = forwardRef(...)`, `const Foo = memo(...)`, `const Foo = memo(forwardRef(...))`, and `function Foo() { ... }`. Terser preserves the string literal even when it mangles the variable.

## Install

```bash
pnpm add -D @everframe/babel-plugin-displayname
```

## Use

In your `babel.config.js`:

```js
module.exports = {
  plugins: ['@everframe/babel-plugin-displayname'],
  // ... your other plugins
};
```

If you use a custom React factory (e.g. `withProfiler`):

```js
module.exports = {
  plugins: [
    ['@everframe/babel-plugin-displayname', { factories: ['withProfiler'] }],
  ],
};
```

## Sister package

If your project uses SWC (Next.js 12+, Metro for RN), use [`@everframe/swc-plugin-displayname`](../swc-plugin-displayname) instead. Both plugins implement identical case behavior — see `__tests__/fixtures/displayname-cases.md`.

## Behavior

- Inserted after `const Foo = forwardRef(...)` and `const Foo = memo(...)`
- Inserted after nested `const Foo = memo(forwardRef(...))`
- Inserted after `function Foo() {}` when name starts uppercase (component heuristic)
- NOT inserted for plain arrow `const Plain = () => null` (no factory wrap)
- NOT inserted when user already explicitly set `.displayName` in the same scope
