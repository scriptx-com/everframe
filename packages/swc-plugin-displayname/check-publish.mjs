#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Publish-readiness gate for the SWC plugin, wrapped so it agrees with this
// package's own optional-Rust contract.
//
// `build-wasm.mjs` deliberately WARNS-and-continues when cargo is unavailable
// (see its header): the JS wrapper still builds and the transform tests skip
// via `describe.skipIf(!wasmAvailable)`. CI installs no Rust toolchain, so on
// every CI leg and every non-rustup dev machine the .wasm simply is not there.
//
// `publint` does not know about that contract. It reads
// `exports["./swc_plugin_displayname.wasm"]`, sees no file, and fails — so
// `check:publish` was red everywhere the artifact is legitimately optional,
// which is everywhere CI runs. Running the real gate only when the artifact
// exists keeps it honest in both directions: a Rust-enabled environment gets
// the full attw + publint check including the wasm subpath, and an
// environment that skipped the Rust build says so instead of failing.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const wasm = path.join(dir, 'swc_plugin_displayname.wasm');

if (!existsSync(wasm)) {
  // In CI the artifact must EXIST. The workflow installs the Rust toolchain and
  // the wasm32-wasip1 target precisely so it can be built, so its absence there
  // means the build silently did not happen — and a skip would hand back a
  // green check for an unverified package. That is how this package came to
  // have a Rust build that did not compile at all (a serde release removed
  // `serde::__private`, which swc_common 13 used) without anything going red.
  if (process.env.CI) {
    console.error('[check:publish] FAIL — swc_plugin_displayname.wasm is missing in CI.');
    console.error('[check:publish]   CI installs rustup + wasm32-wasip1, so the artifact should exist.');
    console.error('[check:publish]   A skip here would pass an unverified package; refusing.');
    process.exit(1);
  }
  console.log('[check:publish] SKIP @everframe/swc-plugin-displayname —');
  console.log('[check:publish]   swc_plugin_displayname.wasm was not built (no cargo in this');
  console.log('[check:publish]   environment; see build-wasm.mjs). The package declares that');
  console.log('[check:publish]   file as a subpath export, so publint cannot verify the');
  console.log('[check:publish]   package without it. Install rustup + the wasm32-wasip1 target');
  console.log('[check:publish]   and re-run to exercise the real gate.');
  process.exit(0);
}

const run = (cmd, args) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: dir, shell: process.platform === 'win32' });

run('pnpm', [
  'exec',
  'attw',
  '--pack',
  '.',
  '--profile',
  'esm-only',
  '--ignore-rules',
  'cjs-resolves-to-esm',
  // The .wasm subpath is a DATA asset, not a module: attw resolves every
  // entrypoint expecting types or JS and reports "Resolution failed" for it,
  // which says nothing about whether the package is publishable. publint,
  // below, is what actually verifies the file exists — and that check is the
  // reason this wrapper waits for the artifact instead of skipping past it.
  '--exclude-entrypoints',
  './swc_plugin_displayname.wasm',
]);
run('pnpm', ['exec', 'publint']);
