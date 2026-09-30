// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment node */
// The smart-TV capture path runs on Chrome 53 (webOS 4). The published build
// targets es2022 SYNTAX (consumers transpile), but runtime built-ins newer
// than Chrome 53 are not polyfilled by a syntax transform: one call to
// `String.prototype.trimEnd` made every TV snapshot throw. This bundles the
// TV-path modules exactly as the lazy chunks carry them — our own sources
// plus rrweb-snapshot, every other package left external — and fails on any
// post-Chrome-53 built-in.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { build, type BuildOptions, type Plugin } from 'esbuild';
import { ensureGlobalThis, globalScope } from '../../src/internal/global-scope.js';

const PKG = path.resolve(__dirname, '..', '..');
const SRC = path.join(PKG, 'src');
/** What the tv-snapshot and companion-submit chunks are built from (besides shared eager code). */
const TV_PATH = [
  path.join(SRC, 'capture/tv-snapshot') + path.sep,
  path.join(SRC, 'capture/shot-capture.ts'),
  path.join(SRC, 'capture/sha256.ts'),
  path.join(SRC, 'companion/companion-submit.ts'),
  path.join(SRC, 'internal/blob.ts'),
  `${path.sep}node_modules${path.sep}rrweb-snapshot${path.sep}`,
];

const FORBIDDEN =
  /\.(?:trimEnd|trimStart|trimLeft|trimRight|padStart|padEnd|flat|flatMap|at|replaceAll|matchAll)\(|Object\.(?:hasOwn|fromEntries|values|entries|getOwnPropertyDescriptors)\b|Promise\.(?:allSettled|any)\b|\bstructuredClone\b|AbortSignal\.timeout|\bqueueMicrotask\b|\(\?<[=!A-Za-z]|\bglobalThis\b/g;

/**
 * rrweb-snapshot's own two `globalThis` reads. They are safe only because
 * takeDomSnapshot calls ensureGlobalThis() before any rrweb code runs
 * (asserted below); any OTHER `globalThis` fails this spec.
 */
const RRWEB_GLOBALTHIS = ['!!globalThis.Zone', 'globalThis[key]'];

const tvPathOnly: Plugin = {
  name: 'tv-path-only',
  setup(b) {
    b.onResolve({ filter: /.*/ }, async (args) => {
      if (args.kind === 'entry-point' || args.pluginData === 'inner') return undefined;
      const resolved = await b.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, importer: args.importer, pluginData: 'inner' });
      if (resolved.errors.length > 0) return { path: args.path, external: true };
      return TV_PATH.some((p) => resolved.path.startsWith(p) || resolved.path.includes(p)) ? { path: resolved.path } : { path: args.path, external: true };
    });
  },
};

async function tvPathCode(): Promise<string> {
  const result = await build({
    entryPoints: [path.join(SRC, 'capture/tv-snapshot/tv-snapshot.ts'), path.join(SRC, 'companion/companion-submit.ts')],
    bundle: true,
    write: false,
    outdir: '/tmp/tv-path-builtins',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    legalComments: 'none',
    logLevel: 'silent',
    define: { __EVERFRAME_INGEST_URL__: '""' },
    plugins: [tvPathOnly],
  });
  // Comments stripped so prose ("…trimEnd() is Chrome 66+…") cannot trip it.
  return result.outputFiles.map((f) => f.text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')).join('\n');
}

describe('smart-TV path uses no post-Chrome-53 runtime built-ins', () => {
  it('the bundled TV-path code (own sources + rrweb-snapshot) is clean', async () => {
    let code = await tvPathCode();
    expect(code).toContain('rr_scrollLeft'); // rrweb-snapshot really is in the bundle
    for (const allowed of RRWEB_GLOBALTHIS) {
      expect(code, `rrweb-snapshot's ${allowed}`).toContain(allowed);
      code = code.split(allowed).join('');
    }
    expect(code.match(FORBIDDEN) ?? []).toEqual([]);
  }, 60_000);

  it('takeDomSnapshot installs globalThis before rrweb-snapshot runs', () => {
    const src = readFileSync(path.join(SRC, 'capture/tv-snapshot/serialize.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function takeDomSnapshot'));
    expect(body.indexOf('ensureGlobalThis();')).toBeGreaterThan(-1);
    expect(body.indexOf('ensureGlobalThis();')).toBeLessThan(body.indexOf('snapshot('));
  });

  it('sdk-core gzipBytes (the snapshot compressor) never reads bare globalThis', () => {
    const src = readFileSync(path.join(PKG, '../sdk-core/src/transport/compression.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src.match(FORBIDDEN) ?? []).toEqual([]);
  });
});

describe('global-scope helpers', () => {
  it('globalScope() is the global object', () => {
    expect(globalScope()).toBe(globalThis);
  });

  it('ensureGlobalThis defines it on an engine that lacks it, and leaves a present one alone', () => {
    const scope: Record<string, unknown> = {};
    ensureGlobalThis(scope, () => false);
    expect(scope.globalThis).toBe(scope);
    const other: Record<string, unknown> = {};
    ensureGlobalThis(other, () => true);
    expect(other).not.toHaveProperty('globalThis');
  });
});

// Regex SYNTAX that no transpiler can lower for an old engine: lookbehind
// (Chrome 62), named groups (64), `\p{…}` (64) and the `s` flag (62). In a
// regex LITERAL any of them is a SyntaxError for the whole module at load —
// a lookbehind in vitals/sanitize-source.ts kept the entire SDK from loading
// on webOS 4. Detected with esbuild itself: told the engine lacks these
// features, esbuild rewrites every literal that uses one into a
// `new RegExp(…)` call, so any difference in that count is such a literal.
const OLD_REGEX: BuildOptions['supported'] = {
  'regexp-dot-all-flag': false,
  'regexp-lookbehind-assertions': false,
  'regexp-named-capture-groups': false,
  'regexp-unicode-property-escapes': false,
};

async function eagerCode(supported: BuildOptions['supported']): Promise<string> {
  const outdir = path.join(PKG, '.regex-probe-out');
  const result = await build({
    absWorkingDir: PKG,
    entryPoints: ['src/index.ts'],
    bundle: true,
    splitting: true,
    write: false,
    outdir,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    ...(supported !== undefined ? { supported } : {}),
    metafile: true,
    logLevel: 'silent',
    define: { __EVERFRAME_INGEST_URL__: '""' },
  });
  // The always-loaded graph: the entry plus every chunk it imports statically.
  const outputs = result.metafile!.outputs;
  const entry = Object.keys(outputs).find((k) => outputs[k]!.entryPoint === 'src/index.ts')!;
  const eager = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (eager.has(next)) continue;
    eager.add(next);
    for (const imp of outputs[next]!.imports) if (imp.kind === 'import-statement') queue.push(imp.path);
  }
  const wanted = new Set([...eager].map((k) => path.resolve(PKG, k)));
  return result.outputFiles.filter((f) => wanted.has(f.path)).map((f) => f.text).join('\n');
}

const regexCtorCount = (code: string): number => code.split('new RegExp(').length - 1;

describe('no regex literal an old TV engine cannot parse', () => {
  it('the always-loaded bundle (entry + static chunks) has none', async () => {
    const [modern, old] = await Promise.all([eagerCode(undefined), eagerCode(OLD_REGEX)]);
    expect(regexCtorCount(old) - regexCtorCount(modern)).toBe(0);
  }, 120_000);

  it('the TV-path bundle has none', async () => {
    const base = {
      entryPoints: [path.join(SRC, 'capture/tv-snapshot/tv-snapshot.ts'), path.join(SRC, 'companion/companion-submit.ts')],
      bundle: true, write: false, outdir: '/tmp/tv-path-regex', format: 'esm' as const, platform: 'browser' as const,
      target: 'es2022', logLevel: 'silent' as const, define: { __EVERFRAME_INGEST_URL__: '""' }, plugins: [tvPathOnly],
    };
    const text = async (supported?: BuildOptions['supported']) =>
      (await build({ ...base, ...(supported !== undefined ? { supported } : {}) })).outputFiles.map((f) => f.text).join('\n');
    expect(regexCtorCount(await text(OLD_REGEX)) - regexCtorCount(await text())).toBe(0);
  }, 60_000);

  it('no SDK source file writes one as a literal (a guarded new RegExp string is the only allowed form)', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name)) {
          readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
            const t = line.trim();
            if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return;
            if (!/\(\?<[=!A-Za-z]|\\[pP]\{/.test(line)) return;
            // Inside a string handed to `new RegExp` (runtime-compiled, try/catch-guarded) is fine.
            if (/new RegExp\(\s*['"`]/.test(line)) return;
            offenders.push(`${path.relative(PKG, full)}:${i + 1}: ${t}`);
          });
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});

