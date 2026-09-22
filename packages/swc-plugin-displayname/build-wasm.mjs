#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Detect cargo availability. CI's Rust-enabled job is the strict gate for the
// WASM transform; on non-Rust environments (local dev without rustup, CI legs
// that intentionally skip Rust), we WARN and continue so the JS wrapper still
// builds and the rest of the workspace phase-gate (build/test/smoke) stays green.
// This mirrors the test-side `describe.skipIf(!wasmAvailable)` pattern.
function cargoAvailable() {
  try {
    execSync('cargo --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!cargoAvailable()) {
  console.warn('[swc-plugin] cargo not found — skipping WASM build.');
  console.warn('[swc-plugin] JS wrapper (tsup) will still build; the WASM transform tests will skip via skipIf(!wasmAvailable).');
  console.warn('[swc-plugin] To produce the WASM artifact, install rustup and run:');
  console.warn('[swc-plugin]   rustup target add wasm32-wasip1');
  process.exit(0);
}

// Having cargo is not the same as being able to build for wasm. The
// ubuntu-latest runner ships a full Rust toolchain but NOT the wasm32-wasip1
// target, so `cargoAvailable()` returned true, the build ran, and it died with
// "can't find crate for `core` … the wasm32-wasip1 target may not be
// installed" — taking `pnpm build`, and therefore the whole CI job, with it.
//
// That defeats this script's stated contract (see the header): environments
// without the Rust half WARN and continue so the JS wrapper still builds and
// the rest of the workspace stays green. The contract was just keyed on the
// wrong signal — presence of cargo rather than ability to target wasm.
//
// To turn this into a REAL gate rather than a skip, add the target in CI:
//   rustup target add wasm32-wasip1
// With it installed this branch is not taken, the artifact is produced, and
// check-publish.mjs then verifies the .wasm subpath export for real too.
function wasmTargetInstalled() {
  try {
    const out = execSync('rustup target list --installed', { encoding: 'utf8' });
    return out.split('\n').some((line) => line.trim() === 'wasm32-wasip1');
  } catch {
    // No rustup (a distro-packaged cargo, say). Fall through to attempting the
    // build: if it works we get the artifact, and if it fails the catch below
    // reports it as the real error it is.
    return true;
  }
}

if (!wasmTargetInstalled()) {
  console.warn('[swc-plugin] cargo is present but the wasm32-wasip1 target is not installed — skipping WASM build.');
  console.warn('[swc-plugin] JS wrapper (tsup) will still build; the WASM transform tests skip via skipIf(!wasmAvailable).');
  console.warn('[swc-plugin] To produce the WASM artifact, run:');
  console.warn('[swc-plugin]   rustup target add wasm32-wasip1');
  process.exit(0);
}

console.log('[swc-plugin] Building WASM via cargo...');
try {
  execSync('cargo build --target wasm32-wasip1 --release', {
    cwd: __dirname,
    stdio: 'inherit',
  });
} catch (err) {
  // Cargo present but build failed — that IS a real error worth surfacing.
  console.error('[swc-plugin] cargo build failed.');
  console.error('Ensure the wasm32-wasip1 target is added:');
  console.error('  rustup target add wasm32-wasip1');
  process.exit(1);
}

const artifact = path.join(__dirname, 'target', 'wasm32-wasip1', 'release', 'traceitx_swc_plugin_displayname.wasm');
if (!existsSync(artifact)) {
  console.error(`[swc-plugin] expected artifact at ${artifact} not found`);
  process.exit(1);
}
const target = path.join(__dirname, 'swc_plugin_displayname.wasm');
copyFileSync(artifact, target);
console.log(`[swc-plugin] copied to ${target}`);
