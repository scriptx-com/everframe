#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REACT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ROOT = resolve(REACT_ROOT, '../sdk-web');
const REPO_ROOT = resolve(REACT_ROOT, '../..');
const TSC_BIN = resolve(REPO_ROOT, 'node_modules/typescript/bin/tsc');

function runPnpm(args) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : 'pnpm';
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;
  const result = spawnSync(command, commandArgs, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

runPnpm(['exec', 'turbo', 'run', 'build', '--filter=@traceitx/react...', '--force']);

const consumer = mkdtempSync(join(tmpdir(), 'traceitx-error-severity-'));
try {
  const scope = join(consumer, 'node_modules/@traceitx');
  mkdirSync(scope, { recursive: true });
  symlinkSync(WEB_ROOT, join(scope, 'web'), 'dir');
  symlinkSync(REACT_ROOT, join(scope, 'react'), 'dir');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    files: ['consumer.ts'],
  }));
  writeFileSync(join(consumer, 'consumer.ts'), `
import type { ErrorSeverity as WebErrorSeverity } from '@traceitx/web';
import type { ErrorSeverity as ReactErrorSeverity } from '@traceitx/react';
import * as web from '@traceitx/web';
import * as react from '@traceitx/react';

const webSeverity: WebErrorSeverity = 'warning';
const reactSeverity: ReactErrorSeverity = 'info';
void webSeverity;
void reactSeverity;
// @ts-expect-error ErrorSeverity is a type-only web export.
void web.ErrorSeverity;
// @ts-expect-error ErrorSeverity is a type-only React export.
void react.ErrorSeverity;
`);

  const checked = spawnSync(process.execPath, [TSC_BIN, '--project', join(consumer, 'tsconfig.json')], {
    cwd: consumer,
    encoding: 'utf8',
  });
  if (checked.error) throw checked.error;
  assert.equal(checked.stderr + checked.stdout, '');
  assert.equal(checked.status, 0);

  const [web, react] = await Promise.all([
    import(pathToFileURL(resolve(WEB_ROOT, 'dist/index.js')).href),
    import(pathToFileURL(resolve(REACT_ROOT, 'dist/index.js')).href),
  ]);
  assert.equal(typeof web.init, 'function');
  assert.equal(typeof react.captureException, 'function');
  assert.equal(Object.hasOwn(web, 'ErrorSeverity'), false);
  assert.equal(Object.hasOwn(react, 'ErrorSeverity'), false);
  console.log('[error-severity-artifacts] type imports and 2 runtime modules verified');
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
