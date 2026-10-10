// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The published file must be accepted by the Vega toolchain: React Native
// 0.72's Babel parses it (no `static {}` blocks, which es2022 + keepNames
// emitted for the RN SDK) and Vega OS 1.1's Hermes 0.12 runs it (no crypto,
// structuredClone, WeakRef or TextDecoder). The real tsup config is built
// into a temp dir and parsed as ES2019.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const FORBIDDEN_GLOBALS = ['crypto', 'structuredClone', 'WeakRef', 'TextDecoder', 'FinalizationRegistry', 'require'];

let outDir: string;
let code: string;

beforeAll(() => {
  outDir = mkdtempSync(path.join(tmpdir(), 'everframe-vega-dist-'));
  // node-linker=hoisted: tsup lives in the workspace root, so resolve its CLI.
  const require = createRequire(path.join(pkgDir, 'package.json'));
  const manifest = require('tsup/package.json') as { bin: Record<string, string> };
  const cli = path.join(path.dirname(require.resolve('tsup/package.json')), manifest.bin.tsup!);
  execFileSync(process.execPath, [cli, '--out-dir', outDir, '--no-dts', '--silent'], {
    cwd: pkgDir,
    stdio: 'pipe',
  });
  code = readFileSync(path.join(outDir, 'index.js'), 'utf8');
}, 60_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

type Node = { type: string; [key: string]: unknown };

function freeIdentifiers(ast: Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: unknown, parent?: Node, key?: string): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((child) => visit(child, parent, key));
    const n = node as Node;
    if (typeof n.type !== 'string') return;
    if (n.type === 'Identifier') {
      const isProperty = (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed)
        || (parent?.type === 'Property' && key === 'key' && !parent.computed);
      if (!isProperty) names.add(n.name as string);
      return;
    }
    for (const [childKey, child] of Object.entries(n)) {
      if (childKey !== 'type' && childKey !== 'start' && childKey !== 'end') visit(child, n, childKey);
    }
  };
  visit(ast);
  return names;
}

describe('published bundle', () => {
  it('parses as ES2019', () => {
    expect(() => parse(code, { ecmaVersion: 2019, sourceType: 'module' })).not.toThrow();
  });

  it('references no global Vega OS 1.1 Hermes lacks', () => {
    const names = freeIdentifiers(parse(code, { ecmaVersion: 2019, sourceType: 'module' }) as unknown as Node);
    expect(FORBIDDEN_GLOBALS.filter((name) => names.has(name))).toEqual([]);
  });

  it('imports only react-native and inlines everything else', () => {
    const imports = [...code.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual(['react-native']);
    expect(code).not.toMatch(/from ["'](?:zod|@everframe\/|@noble\/)/);
  });

  it('names the package version it was built from', () => {
    const { version } = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { version: string };
    expect(code).toContain(JSON.stringify(version));
    expect(code).not.toContain('__EVERFRAME_VEGA_VERSION__ ===');
  });

  it('stays small', () => {
    expect(code.length).toBeLessThan(120 * 1024);
  });
});
