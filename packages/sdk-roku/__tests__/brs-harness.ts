// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Runs BrightScript under brs-node's `brs-cli` (SceneGraph disabled with -n).
// Test code reports results with:  print "EFTEST:" + FormatJson(value)
// Each run starts with an empty simulated registry (no -y), so tests are isolated.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIB_DIR = path.join(PKG, 'library/components/Everframe/lib');
export const HOOK_DIR = path.join(PKG, 'hook');
// brs-node lives in test-tools/, a standalone install outside the pnpm workspace
// (its native `canvas` dependency must not reach the shared node_modules).
// The package `test` script installs it via scripts/ensure-brs.mjs.
const BRS_CLI = path.join(PKG, 'test-tools/node_modules/.bin/brs-cli');
if (!existsSync(BRS_CLI)) {
  throw new Error(
    `brs-cli not found at ${BRS_CLI}. Run \`pnpm --filter @everframe/roku test\` ` +
      '(or `node scripts/ensure-brs.mjs` in packages/sdk-roku) to install the test interpreter.',
  );
}

export function brsString(s: string): string {
  return '"' + s.replace(/"/g, '""') + '"';
}

export function runBrs(
  libFiles: string[],
  mainBody: string,
  opts: { extraFiles?: string[] } = {},
): Promise<{ lines: any[]; stdout: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'efbrs-'));
  const main = path.join(dir, 'main.brs');
  writeFileSync(main, `sub Main()\n${mainBody}\nend sub\n`);
  const files = [main, ...libFiles.map((f) => path.join(LIB_DIR, f)), ...(opts.extraFiles ?? [])];
  return new Promise((resolve) => {
    // A deliberate crash exits non-zero; stdout is still what we assert on.
    execFile(BRS_CLI, ['-n', ...files], { timeout: 50000 }, (_err, stdout) => {
      const lines = String(stdout)
        .split('\n')
        .filter((l) => l.startsWith('EFTEST:'))
        .map((l) => JSON.parse(l.slice('EFTEST:'.length)));
      resolve({ lines, stdout: String(stdout) });
    });
  });
}
