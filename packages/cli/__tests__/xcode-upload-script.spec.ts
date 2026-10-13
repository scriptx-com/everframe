// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { xcodePhaseScript } from '../src/native-setup/index.js';
import { XCODE_DEBUG_SKIP, XCODE_NO_TOKEN_WARNING } from '../src/xcode-build-phase.js';

const APP = '00000000-0000-4000-8000-000000000000';
const PACKAGE = join(__dirname, '..');
const SCRIPT = join(PACKAGE, 'scripts/xcode-upload.sh');
const CONTINUES =
  'Build artifacts were not uploaded and the build continues. Set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * An app with `ios/` and the script installed at `node_modules/@everframe/cli`, beside a stub
 * `dist/index.js` that records its arguments and exits with `exitCode`. With `pnpm`, the package
 * folder is a symlink into a versioned store folder, as pnpm installs it.
 */
function app(options: { exitCode?: number; pnpm?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'everframe-xcode-upload-'));
  roots.push(root);
  mkdirSync(join(root, 'ios'));
  const linked = join(root, 'node_modules/@everframe/cli');
  const cli = options.pnpm ? join(root, 'node_modules/.pnpm/@everframe+cli@9.9.9/node_modules/@everframe/cli') : linked;
  mkdirSync(join(cli, 'scripts'), { recursive: true });
  mkdirSync(join(cli, 'dist'));
  copyFileSync(SCRIPT, join(cli, 'scripts/xcode-upload.sh'));
  const record = join(root, 'args.json');
  writeFileSync(
    join(cli, 'dist/index.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(${options.exitCode ?? 0});\n`,
  );
  mkdirSync(dirname(linked), { recursive: true });
  if (options.pnpm) symlinkSync('../.pnpm/@everframe+cli@9.9.9/node_modules/@everframe/cli', linked);
  // The generated phase line, as Xcode runs it: bash -c with the phase's shell.
  const line = xcodePhaseScript(APP);
  const run = (env: Record<string, string>) =>
    spawnSync('/bin/bash', ['-c', line], {
      env: { PATH: process.env.PATH!, SRCROOT: join(root, 'ios'), CONFIGURATION: 'Release', NODE_BINARY: process.execPath, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  return {
    root,
    srcroot: join(root, 'ios'),
    run,
    args: () => (existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as string[]) : undefined),
  };
}

describe('scripts/xcode-upload.sh', () => {
  it('is executable and ships in the package as a bin, which keeps it executable when packed and installed', () => {
    expect(statSync(SCRIPT).mode & 0o111).toBe(0o111);
    const pkg = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as { files: string[]; bin: Record<string, string> };
    expect(pkg.files).toContain('scripts');
    // pnpm pack writes 0644 for every file that is not a bin.
    expect(pkg.bin['everframe-xcode-upload']).toBe('./scripts/xcode-upload.sh');
  });

  it('runs `everframe xcode build-phase` from its own package with the phase arguments', () => {
    const h = app();
    const result = h.run({});
    expect(result.status).toBe(0);
    expect(h.args()).toEqual(['xcode', 'build-phase', '--app-id', APP]);
  });

  it('finds its package through a pnpm symlink', () => {
    const h = app({ pnpm: true });
    expect(h.run({}).status).toBe(0);
    expect(h.args()).toEqual(['xcode', 'build-phase', '--app-id', APP]);
  });

  it.each([{ CONFIGURATION: 'Debug' }, { SKIP_BUNDLING: '1' }])('skips %o before Node, even when strict and Node is missing', (env) => {
    const h = app();
    const result = h.run({ ...env, NODE_BINARY: '/nonexistent/node', EVERFRAME_SYMBOLS_STRICT: '1' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(XCODE_DEBUG_SKIP);
    expect(result.stderr).toBe('');
    expect(h.args()).toBeUndefined();
  });

  it("takes NODE_BINARY from the project's .xcode.env files, .xcode.env.local last", () => {
    const h = app();
    writeFileSync(join(h.srcroot, '.xcode.env'), 'export NODE_BINARY=/nonexistent/node\n');
    writeFileSync(join(h.srcroot, '.xcode.env.local'), `export NODE_BINARY="${process.execPath}"\n`);
    expect(h.run({ NODE_BINARY: '' }).status).toBe(0);
    expect(h.args()).toEqual(['xcode', 'build-phase', '--app-id', APP]);
  });

  it('tolerates unset variables in the .xcode.env files', () => {
    const h = app();
    writeFileSync(join(h.srcroot, '.xcode.env'), 'export EVERFRAME_TEST_FROM_ENV="$EVERFRAME_TEST_NEVER_SET"\n');
    const result = h.run({});
    expect(result.stderr).not.toContain('unbound variable');
    expect(result.status).toBe(0);
    expect(h.args()).toBeDefined();
  });

  it('warns and continues when Node is missing, and fails when strict', () => {
    const h = app();
    const lenient = h.run({ NODE_BINARY: '/nonexistent/node' });
    expect(lenient.status).toBe(0);
    expect(lenient.stdout.trim()).toBe(
      `warning: everframe: Node was not found (NODE_BINARY=/nonexistent/node). Set NODE_BINARY in ios/.xcode.env.local. ${CONTINUES}`,
    );
    for (const strict of ['1', 'true']) {
      const result = h.run({ NODE_BINARY: '/nonexistent/node', EVERFRAME_SYMBOLS_STRICT: strict });
      expect(result.status).toBe(1);
      expect(result.stdout.trim()).toBe(
        'error: everframe: Node was not found (NODE_BINARY=/nonexistent/node). Set NODE_BINARY in ios/.xcode.env.local.',
      );
    }
    expect(h.args()).toBeUndefined();
  });

  it('turns a failed CLI run into a warning, and keeps its status when strict', () => {
    const h = app({ exitCode: 3 });
    const lenient = h.run({});
    expect(lenient.status).toBe(0);
    expect(lenient.stdout.trim()).toBe(`warning: everframe: @everframe/cli stopped with exit status 3. ${CONTINUES}`);
    const strict = h.run({ EVERFRAME_SYMBOLS_STRICT: '1' });
    expect(strict.status).toBe(3);
    expect(strict.stdout).not.toContain('warning:');
  });

  it('warns and continues when an incomplete install cannot start the CLI', () => {
    const h = app();
    rmSync(join(h.root, 'node_modules/@everframe/cli/dist'), { recursive: true });
    const result = h.run({});
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Cannot find module');
    expect(result.stdout).toContain('warning: everframe: @everframe/cli stopped with exit status 1.');
  });

  describe('the phase line without an installed CLI', () => {
    const missing = (h: ReturnType<typeof app>) => {
      rmSync(join(h.root, 'node_modules'), { recursive: true });
      return `${h.srcroot}/../node_modules/@everframe/cli/scripts/xcode-upload.sh`;
    };

    it('warns and lets the build continue', () => {
      const h = app();
      const path = missing(h);
      const result = h.run({});
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(
        `warning: everframe: @everframe/cli is not installed: ${path} is missing. Build artifacts were not uploaded and the build continues. Install @everframe/cli in the app, or set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.`,
      );
    });

    it.each(['1', 'true'])('fails the build when EVERFRAME_SYMBOLS_STRICT=%s', (strict) => {
      const h = app();
      const path = missing(h);
      const result = h.run({ EVERFRAME_SYMBOLS_STRICT: strict });
      expect(result.status).toBe(1);
      expect(result.stdout.trim()).toBe(`error: everframe: @everframe/cli is not installed: ${path} is missing.`);
    });

    it('treats a script without its executable bit as missing', () => {
      const h = app();
      chmodSync(join(h.root, 'node_modules/@everframe/cli/scripts/xcode-upload.sh'), 0o644);
      const result = h.run({});
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('warning: everframe: @everframe/cli is not installed');
      expect(h.args()).toBeUndefined();
    });
  });

  describe('with the built CLI', () => {
    const run = (env: Record<string, string>) =>
      spawnSync('/bin/bash', [SCRIPT, '--app-id', APP], {
        env: { PATH: process.env.PATH!, SRCROOT: '/nonexistent/ios', CONFIGURATION: 'Release', NODE_BINARY: process.execPath, ...env },
        encoding: 'utf8',
      });

    it('warns and succeeds in a Release build without a token', () => {
      const result = run({});
      expect(result.status).toBe(0);
      expect(result.stderr.trim()).toBe(XCODE_NO_TOKEN_WARNING);
    });

    it('fails a strict Release build without a token', () => {
      const result = run({ EVERFRAME_SYMBOLS_STRICT: '1' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('error: everframe: missing_api_token');
    });
  });
});
