// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// RULING 15 and RULING 11 are the same rule seen from either side of the
// dynamic-import boundary, and both are invisible to every behavioural test:
// break either one and the suite still goes green — only the shipped bundle
// changes. So they are asserted here, on the module graph itself.
//
//   Ruling 15  Nothing STATICALLY reachable from src/index.ts may import
//              './ui.js' (which re-exports ReporterDialog) or react/react-dom
//              directly. A single such edge puts React in the always-loaded
//              entry and the React-absence gate goes from 0 to non-zero.
//
//   Ruling 11  The lazily-imported island must reach the dialog by the
//              RELATIVE path '../ui.js', never the package subpath
//              '@everframe/web/ui'. The subpath resolves to the separately
//              built dist/ui.js, which shares no chunk with dist/index.js —
//              giving a vanilla host TWO copies of every module-level
//              singleton (portal target, theme host, inline theme, companion
//              host seam). init() would write its seams on copy A and the
//              dialog would read copy B: the reporter opens and captures
//              nothing.
//
// The walk below follows STATIC imports only. A dynamic `import()` is a chunk
// split point, so it is deliberately a boundary here too — that is precisely
// what makes the island's React legal.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

/** Resolve a relative './x.js' specifier to the .ts/.tsx source behind it. */
function resolveSource(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Static import/export specifiers that survive to runtime. `import type` /
 * `export type` are erased outright by `verbatimModuleSyntax`, so they are
 * skipped; `import { type X } from 'y'` is NOT skipped, because it still
 * emits a side-effect import.
 */
function staticSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)(?!\s+type\b)(?:[\s\S]*?)\sfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) out.push(m[1] as string);
  // Bare side-effect imports: `import './x.js';`
  const side = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  while ((m = side.exec(source))) out.push(m[1] as string);
  return out;
}

/** Every module statically reachable from `entry`, plus the bare specifiers seen. */
function walk(entry: string): { files: string[]; bare: Map<string, string[]> } {
  const seen = new Set<string>();
  const bare = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticSpecifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        const target = resolveSource(file, spec);
        if (target) queue.push(target);
        continue;
      }
      const importers = bare.get(spec) ?? [];
      importers.push(file);
      bare.set(spec, importers);
    }
  }
  return { files: [...seen], bare };
}

describe('always-loaded graph (Ruling 15)', () => {
  const graph = walk(resolve(SRC, 'index.ts'));

  it('reaches no React package by a static import', () => {
    const react = [...graph.bare.keys()].filter((s) =>
      /^(react|react-dom|react-konva|lucide-react)(\/|$)/.test(s),
    );
    expect({ react, importers: react.map((r) => graph.bare.get(r)) }).toEqual({
      react: [],
      importers: [],
    });
  });

  it("never reaches './ui.js' — the barrel that re-exports ReporterDialog", () => {
    expect(graph.files.filter((f) => f.endsWith('/src/ui.ts'))).toEqual([]);
  });

  it('does not statically reach the React island', () => {
    expect(graph.files.filter((f) => f.endsWith('react-island.tsx'))).toEqual([]);
  });

  it('DOES reach the plain-DOM ambient UI (it is the ambient footprint)', () => {
    expect(graph.files.some((f) => f.endsWith('/src/mount/ambient.ts'))).toBe(true);
  });
});

describe('the lazy island (Ruling 11)', () => {
  const island = readFileSync(resolve(SRC, 'mount/react-island.tsx'), 'utf8');

  it("imports the dialog by the relative path '../ui.js'", () => {
    expect(staticSpecifiers(island)).toContain('../ui.js');
  });

  it("never imports the package subpath '@everframe/web/ui'", () => {
    // The subpath resolves to the separately-built dist/ui.js: a second copy
    // of every seam, in a chunk that shares nothing with dist/index.js.
    // (Checked over the SPECIFIERS, not the raw text — the header comment
    // names the forbidden path in order to explain why it is forbidden.)
    expect(
      staticSpecifiers(island).filter((s) => s.startsWith('@everframe/web')),
    ).toEqual([]);
  });
});
