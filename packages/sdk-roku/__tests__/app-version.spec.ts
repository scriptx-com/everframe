// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { LIB_DIR, brsString, runBrs } from './brs-harness.js';

// A stand-in for roAppInfo: GetValue("everframe_app_version") returns `manifest`.
async function versionFor(manifestExpr: string): Promise<string> {
  const { lines } = await runBrs(
    ['ef_util.brs'],
    `
    ai = {}
    ai.GetVersion = function() as string
      return "1.0.1205000"
    end function
    ai.GetValue = function(key as string) as string
      if key = "everframe_app_version" then return m.manifest
      return ""
    end function
    ai.manifest = ${manifestExpr}
    print "EFTEST:" + FormatJson({ v: EfU_AppVersionFrom(ai) })
    `,
  );
  return lines[0].v;
}

describe('EfU_AppVersionFrom', () => {
  it('reports the manifest value when valid', async () => {
    expect(await versionFor(brsString('12.5.0'))).toBe('12.5.0');
  });

  it('reports the value as written, without trimming', async () => {
    expect(await versionFor(brsString(' 12.5.0 '))).toBe(' 12.5.0 ');
  });

  it('falls back to GetVersion() when the key is missing or empty', async () => {
    expect(await versionFor('""')).toBe('1.0.1205000');
  });

  it('falls back when the value is only whitespace', async () => {
    expect(await versionFor(brsString('   '))).toBe('1.0.1205000');
    expect(await versionFor('Chr(9) + Chr(32)')).toBe('1.0.1205000');
  });

  it('falls back when the value contains a control character', async () => {
    expect(await versionFor('"12" + Chr(10) + "5"')).toBe('1.0.1205000');
    expect(await versionFor('"12" + Chr(31) + "5"')).toBe('1.0.1205000');
  });

  it('accepts 64 characters and rejects 65', async () => {
    expect(await versionFor('String(64, "a")')).toBe('a'.repeat(64));
    expect(await versionFor('String(65, "a")')).toBe('1.0.1205000');
  });

  it('EfU_AppVersion() works against the real roAppInfo', async () => {
    const { lines } = await runBrs(
      ['ef_util.brs'],
      `print "EFTEST:" + FormatJson({ v: EfU_AppVersion(), g: CreateObject("roAppInfo").GetVersion() })`,
    );
    expect(lines[0].v).toBe(lines[0].g);
  });
});

// Source without comment lines.
const code = (f: string) =>
  readFileSync(path.join(LIB_DIR, f), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith("'"))
    .join('\n');

describe('app version call sites', () => {
  it('only the helper reads roAppInfo.GetVersion()', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(LIB_DIR).filter((n) => n.endsWith('.brs'))) {
      const src = code(f);
      if (f !== 'ef_util.brs' && /GetVersion\(\)/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
    expect(code('ef_util.brs').match(/GetVersion\(\)/g)).toHaveLength(1);
  });
});
