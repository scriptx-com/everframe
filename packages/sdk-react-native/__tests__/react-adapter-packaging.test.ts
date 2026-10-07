// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import * as React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let built = '';
// Build the current source with the package's own tsup config, so a missing or
// stale package dist cannot decide the emitted-entry assertions. The output stays
// inside the package (Vitest only loads and aliases workspace files) under the
// git- and watcher-ignored test-results directory.
beforeAll(() => {
  mkdirSync(join(root, 'test-results'), { recursive: true });
  built = mkdtempSync(join(root, 'test-results', 'packaging-'));
  const tsup = createRequire(import.meta.url).resolve('tsup/dist/cli-default.js');
  execFileSync(process.execPath, [tsup, '--out-dir', join(built, 'dist'), '--no-dts', '--silent'], { cwd: root, stdio: 'pipe' });
}, 60_000);
afterAll(() => { if (built) rmSync(built, { recursive: true, force: true }); });
afterEach(cleanup);
it('published native root and adapter share the mounted provider', async () => {
  const native = await import(/* @vite-ignore */ join(built, 'dist/index.js'));
  const adapter = await import(/* @vite-ignore */ join(built, 'dist/integrations/react.js'));
  render(React.createElement(native.EverframeProvider, { config: { apiKey: 'txx_test_key' } }, null));
  adapter.captureReactError(new Error('published adapter'), { componentStack: 'Boundary' });
  expect(native.getErrorCaptureStatus()).toMatchObject({ status: 'active', counters: { handled: { attempted: 1, accepted: 1 } } });
});
it('native subpath resolves while browser-conditioned consumers are rejected before initialization', () => {
  const script = "console.log(import.meta.resolve('@everframe/react-native/integrations/react'))";
  const native = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  expect(native.status, native.stderr).toBe(0); expect(native.stdout).toContain('/dist/integrations/react.js');
  const browser = spawnSync(process.execPath, ['--conditions=browser', '--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  expect(browser.status).not.toBe(0); expect(browser.stderr).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
});
