// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Installs the test-only BrightScript interpreter (brs-node / brs-cli) into
// test-tools/, a standalone directory outside the pnpm workspace. brs-node
// hard-depends on the native `canvas` package; installing it as a workspace
// devDependency hoists canvas into the shared root node_modules, where jsdom
// picks it up and changes behaviour for the web/react test suites.
//
// Installs only when brs-cli is missing or the committed lockfile differs from
// the installed one, so repeat test runs cost nothing.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolDir = path.join(pkg, 'test-tools');
const bin = path.join(toolDir, 'node_modules', '.bin', process.platform === 'win32' ? 'brs-cli.cmd' : 'brs-cli');
const committedLock = path.join(toolDir, 'pnpm-lock.yaml');
const installedLock = path.join(toolDir, 'node_modules', '.pnpm', 'lock.yaml');

// The committed lockfile carries an SPDX header that pnpm does not write.
function lockBody(file) {
  return readFileSync(file, 'utf8').replace(/^(?:#[^\n]*\n|\s*\n)*/, '');
}

function upToDate() {
  if (!existsSync(bin) || !existsSync(installedLock)) return false;
  return lockBody(committedLock) === lockBody(installedLock);
}

if (upToDate()) process.exit(0);

// Run the same pnpm that launched this script when possible.
const execPath = process.env.npm_execpath;
const viaNode = execPath && /pnpm\.c?js$/.test(execPath);
const command = viaNode ? process.execPath : 'pnpm';
const args = [
  ...(viaNode ? [execPath] : []),
  'install',
  '--dir',
  toolDir,
  '--ignore-workspace',
  '--frozen-lockfile',
];

process.stdout.write(`[sdk-roku] installing brs-cli into ${path.relative(process.cwd(), toolDir) || '.'}\n`);
const result = spawnSync(command, args, {
  cwd: toolDir,
  stdio: 'inherit',
  shell: !viaNode && process.platform === 'win32',
});
if (result.status !== 0 || !existsSync(bin)) {
  process.stderr.write(
    `[sdk-roku] failed to install brs-cli into ${toolDir} (exit ${result.status ?? result.signal}).\n`,
  );
  process.exit(result.status || 1);
}
