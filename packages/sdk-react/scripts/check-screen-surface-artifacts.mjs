#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REACT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packed = mkdtempSync(join(tmpdir(), 'everframe-react-screen-surface-'));

try {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : 'pnpm';
  const args = npmExecPath
    ? [npmExecPath, 'pack', '--pack-destination', packed]
    : ['pack', '--pack-destination', packed];
  const pack = spawnSync(command, args, { cwd: REACT_ROOT, encoding: 'utf8' });
  if (pack.error) throw pack.error;
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);

  const tarball = readdirSync(packed).find((entry) => entry.endsWith('.tgz'));
  assert.ok(tarball, 'pnpm pack did not produce a tarball');
  const unpacked = join(packed, 'unpacked');
  mkdirSync(unpacked);
  const extract = spawnSync('tar', ['-xzf', join(packed, tarball), '-C', unpacked], {
    encoding: 'utf8',
  });
  if (extract.error) throw extract.error;
  assert.equal(extract.status, 0, extract.stderr || extract.stdout);

  const declarations = readFileSync(join(unpacked, 'package/dist/index.d.ts'), 'utf8');
  assert.match(declarations, /\bEverframeScreen\b/);
  assert.match(declarations, /\buseEverframeScreen\b/);
  assert.match(declarations, /\bEverframeScreenProps\b/);
  assert.doesNotMatch(declarations, /\b(?:TXScreen|useTXScreen|TXScreenProps)\b/);
  console.log('[screen-surface-artifacts] packed declarations expose only canonical names');
} finally {
  rmSync(packed, { recursive: true, force: true });
}
