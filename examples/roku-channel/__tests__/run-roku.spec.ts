// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { Parser } from 'brighterscript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/run-roku.mjs');
const KEY = 'evf_test_key_do_not_leak_123';
const sdkVersion = JSON.parse(readFileSync(path.join(ROOT, '../../packages/sdk-roku/package.json'), 'utf8')).version;

const baseEnv = { ...process.env, EVERFRAME_ENV_FILE: '/dev/null' };

function build(extra: string[] = [], env: Record<string, string> = {}) {
  return execFileSync(process.execPath, [SCRIPT, '--no-deploy', ...extra], {
    cwd: ROOT,
    env: { ...baseEnv, EVERFRAME_KEY_ROKU: KEY, EVERFRAME_INGEST_URL: '', ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = path.join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const zipFiles = () => unzipSync(readFileSync(path.join(ROOT, '.build/everframe-crash-lab.zip')));

describe('run-roku.mjs --no-deploy', () => {
  it('instruments the channel, bundles the library, and wires the config', () => {
    build();
    const files = zipFiles();
    const zipName = `components/everframe-roku-${sdkVersion}.zip`;
    expect(files[zipName], zipName).toBeDefined();
    const config = strFromU8(files['components/generated/ef_config.brs']!);
    expect(config).toContain(`libraryUri: "pkg:/${zipName}"`);
    expect(config).toContain(`sdkKey: "${KEY}"`);
    expect(strFromU8(files['components/LabScene.brs']!)).toContain("' everframe:instrumented");
    expect(strFromU8(files['components/LabScene.xml']!)).toContain('pkg:/components/everframe_hook/everframe_hook.brs');
    expect(strFromU8(files['components/Excluded.brs']!)).not.toContain('everframe:instrumented');
    expect(strFromU8(files['components/OomTask.brs']!)).not.toContain('everframe:instrumented');
    expect(strFromU8(files['source/main.brs']!)).toContain("' everframe:instrumented");
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith('.brs')) expect(Parser.parse(strFromU8(bytes)).diagnostics, name).toEqual([]);
    }
  });

  it('never leaks the key outside the generated config', () => {
    build();
    for (const [name, bytes] of Object.entries(zipFiles())) {
      if (name === 'components/generated/ef_config.brs' || name.endsWith('.zip')) continue;
      expect(strFromU8(bytes).includes(KEY), name).toBe(false);
    }
    const committed = walk(ROOT).filter((f) => !f.includes(`${path.sep}.build${path.sep}`) && !f.includes(`${path.sep}node_modules${path.sep}`) && !f.includes(`${path.sep}generated${path.sep}`) && !f.endsWith('.spec.ts'));
    for (const f of committed) expect(readFileSync(f, 'utf8').includes(KEY), f).toBe(false);
  });

  it('--no-instrument skips instrumentation but still bundles the library', () => {
    build(['--no-instrument']);
    const files = zipFiles();
    expect(files[`components/everframe-roku-${sdkVersion}.zip`]).toBeDefined();
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith('.brs')) expect(strFromU8(bytes).includes('everframe:instrumented'), name).toBe(false);
    }
  });

  it('--remote-library uses the URL and bundles no zip', () => {
    build(['--remote-library', 'https://cdn.example.com/everframe-roku.zip']);
    const files = zipFiles();
    expect(Object.keys(files).some((n) => n.endsWith('.zip'))).toBe(false);
    expect(strFromU8(files['components/generated/ef_config.brs']!)).toContain('libraryUri: "https://cdn.example.com/everframe-roku.zip"');
  });

  it('warns when the ingest URL is localhost', () => {
    const out = build([], { EVERFRAME_INGEST_URL: 'http://localhost:8787' });
    expect(out).toMatch(/localhost.*TV cannot reach/i);
    expect(strFromU8(zipFiles()['components/generated/ef_config.brs']!)).toContain('endpoint: "http://localhost:8787"');
  });

  it('fails clearly without a key', () => {
    expect(() => build([], { EVERFRAME_KEY_ROKU: '' })).toThrow(/EVERFRAME_KEY_ROKU/);
  });

  it('requires ROKU_HOST when deploying', () => {
    expect(() =>
      execFileSync(process.execPath, [SCRIPT], {
        cwd: ROOT,
        env: { ...baseEnv, EVERFRAME_KEY_ROKU: KEY, ROKU_HOST: '', ROKU_DEV_PASSWORD: '' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).toThrow(/ROKU_HOST/);
  });
});
