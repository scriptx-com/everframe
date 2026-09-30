// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBrs } from './brs-harness.js';

describe('EF_VERSION', () => {
  it('matches package.json version', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const { lines } = await runBrs(['ef_version.brs'], `print "EFTEST:" + FormatJson(EF_VERSION())`);
    expect(lines[0]).toBe(pkg.version);
  });

  it('library manifest carries the package.json version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const [major, minor, build] = String(pkg.version).split('-')[0]!.split('.');
    const manifest = readFileSync(new URL('../library/manifest', import.meta.url), 'utf8');
    expect(manifest).toMatch(new RegExp(`^major_version=${major}$`, 'm'));
    expect(manifest).toMatch(new RegExp(`^minor_version=${minor}$`, 'm'));
    expect(manifest).toMatch(new RegExp(`^build_version=${build}$`, 'm'));
  });

  it('sync-version rewrites ef_version.brs and the manifest from package.json', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'efver-'));
    mkdirSync(path.join(tmp, 'scripts'));
    mkdirSync(path.join(tmp, 'library/components/Everframe/lib'), { recursive: true });
    cpSync(new URL('../scripts/sync-version.mjs', import.meta.url), path.join(tmp, 'scripts/sync-version.mjs'));
    cpSync(new URL('../library/manifest', import.meta.url), path.join(tmp, 'library/manifest'));
    cpSync(new URL('../library/components/Everframe/lib/ef_version.brs', import.meta.url), path.join(tmp, 'library/components/Everframe/lib/ef_version.brs'));
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: '2.13.7-beta.1' }));
    execFileSync(process.execPath, [path.join(tmp, 'scripts/sync-version.mjs')]);
    const brs = readFileSync(path.join(tmp, 'library/components/Everframe/lib/ef_version.brs'), 'utf8');
    const manifest = readFileSync(path.join(tmp, 'library/manifest'), 'utf8');
    expect(brs).toContain('return "2.13.7-beta.1"');
    expect(brs).toMatch(/^' SPDX-License-Identifier: MIT$/m);
    expect(manifest).toMatch(/^major_version=2$/m);
    expect(manifest).toMatch(/^minor_version=13$/m);
    expect(manifest).toMatch(/^build_version=7$/m);
    expect(manifest).toMatch(/^sg_component_libs_provided=Everframe$/m);
    expect(manifest).toMatch(/^# SPDX-License-Identifier: MIT$/m);
  });

  it('package.json runs sync-version before build', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts.prebuild).toBe('node scripts/sync-version.mjs');
  });
});
