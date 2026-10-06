// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import * as React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
afterEach(cleanup);
it('published native root and adapter share the mounted provider', async () => {
  const nativePath = '../dist/index.js', adapterPath = '../dist/integrations/react.js';
  const native = await import(/* @vite-ignore */ nativePath);
  const adapter = await import(/* @vite-ignore */ adapterPath);
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
