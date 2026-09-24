// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// A guard on the BUILT chunk graph, complementing __tests__/mount/
// eager-graph-guard.spec.ts, which reads the SOURCE graph.
//
// The source guard catches the realistic source regression (someone adds a
// static import of './ui.js', or the island reaches for '@everframe/web/ui').
// It cannot catch a CONFIG regression — flipping `splitting` off, or dropping
// react/react-dom from tsup's `noExternal` — because the source is unchanged
// and every jsdom test still passes; only the shipped bundle moves. That gap
// was previously closed by a manual, one-off experiment: build the package two
// ways and diff the output. This is that experiment, as a repeatable check.
//
// It lives here rather than in __tests__ because it reads dist/, and dist/ is
// exactly what this suite already requires. A unit test that silently skips
// when the artifact is missing is worse than no test.
//
// Deliberately name-agnostic, for the same reason as RULING 3 next door: tsup
// picks the chunk filenames and is free to change them.
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');

/** A string that could plausibly be a module specifier (not minified soup). */
const PLAUSIBLE = /^(?:\.{1,2}\/[\w./@-]+|@?[\w][\w./@-]*)$/;

function specifiers(source: string): { static: string[]; dynamic: string[] } {
  const dynamic = new Set<string>();
  const all = new Set<string>();
  let m: RegExpExecArray | null;
  const dyn = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  while ((m = dyn.exec(source))) if (PLAUSIBLE.test(m[2]!)) dynamic.add(m[2]!);
  const any = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"\n]+)\1/g;
  while ((m = any.exec(source))) if (PLAUSIBLE.test(m[2]!)) all.add(m[2]!);
  return { static: [...all].filter((s) => !dynamic.has(s)), dynamic: [...dynamic] };
}

test('the eager entry reaches React only through a dynamic import, and shares the core chunk with it', () => {
  const entry = specifiers(readFileSync(join(DIST, 'index.js'), 'utf8'));

  const siblings = (list: string[]): string[] => list.filter((s) => s.startsWith('./'));
  const eagerChunks = siblings(entry.static);
  const lazyChunks = siblings(entry.dynamic);

  // `splitting: false` inlines the island into the entry: no lazy sibling at
  // all, and React lands in the always-loaded graph.
  expect(lazyChunks.length, 'the entry dynamically imports no sibling chunk').toBeGreaterThan(0);

  const islandFile = lazyChunks.find((s) =>
    /react-dom|__SECRET_INTERNALS/.test(readFileSync(join(DIST, s), 'utf8')),
  );
  expect(islandFile, 'no lazily-imported sibling chunk contains React').toBeTruthy();

  // …and none of the eagerly-imported ones does.
  for (const chunk of eagerChunks) {
    const body = readFileSync(join(DIST, chunk), 'utf8');
    expect(/react-dom|__SECRET_INTERNALS/.test(body), `${chunk} is eager and contains React`).toBe(
      false,
    );
  }

  const island = specifiers(readFileSync(join(DIST, islandFile!), 'utf8'));

  // RULING 11, on the artifact. The island must statically import the SAME
  // core chunk the entry does — that shared chunk is where the module-level
  // seams (portal target, theme host, inline theme, companion host seam) live,
  // and sharing it is what gives the two graphs one instance of each. Pinned
  // to the LARGEST of the entry's eager chunks rather than "some overlap":
  // esbuild emits a sub-kilobyte interop helper that every chunk imports, so
  // a bare intersection test would stay green through the exact regression it
  // is supposed to catch.
  const core = [...eagerChunks].sort(
    (a, b) => statSync(join(DIST, b)).size - statSync(join(DIST, a)).size,
  )[0];
  expect(core, 'the entry statically imports no sibling chunk').toBeTruthy();
  expect(
    island.static,
    `the island does not share the entry's core chunk (${core})`,
  ).toContain(core);

  // Dropping react/react-dom (or konva) from tsup's `noExternal`, or reaching
  // the dialog by the '@everframe/web/ui' subpath, all show up the same way:
  // as a BARE static import in the island, which a vanilla host would then
  // have to install — or, for the subpath, a second copy of every seam.
  const forbidden = [
    'react',
    'react-dom',
    'react-dom/client',
    'react/jsx-runtime',
    'lucide-react',
    'react-konva',
    'konva',
  ];
  expect(island.static.filter((s) => forbidden.includes(s) || s.startsWith('@everframe/'))).toEqual(
    [],
  );

  // Sanity: dist/ui.js — the separately built React entry — DOES carry those
  // bare imports. Without this the check above could pass because the
  // extractor stopped finding anything at all.
  const ui = specifiers(readFileSync(join(DIST, 'ui.js'), 'utf8'));
  expect(ui.static).toContain('react');

  // eslint-disable-next-line no-console
  console.log(
    `[built-graph] entry -> eager ${eagerChunks.join(', ')} | lazy ${islandFile} | core ${core}`,
  );
});

// ---------------------------------------------------------------------------
// The BROWSER entry (`dist/browser/index.js`) — the no-bundler artifact that
// replaced the IIFE. Its invariants are the MIRROR IMAGE of the ESM entry's:
// React is bundled into this graph by design (`noExternal: [/.*/]`), so "no
// React anywhere in the build" is the wrong question. The right ones are "does
// React arrive only through a dynamic import" and "did anything bare survive".

const BROWSER = join(DIST, 'browser');

/**
 * Specifiers, but matched only where a MINIFIED bundle emits them — the quote
 * immediately after `from` / `import`, with no space between.
 *
 * `specifiers()` above is deliberately loose and, on both entries,
 * false-positives on an English error message containing the phrase
 * `from '@everframe/web'` (with spaces). That is harmless there, because every
 * assertion up there filters down to `./`-prefixed siblings. It is not
 * harmless here: the check below is precisely "is any BARE specifier left", so
 * one prose match would fail it forever. esbuild never puts a space there;
 * prose always does.
 */
function emittedSpecifiers(source: string): { static: string[]; dynamic: string[] } {
  const dynamic = new Set<string>();
  const all = new Set<string>();
  let m: RegExpExecArray | null;
  const dyn = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  while ((m = dyn.exec(source))) if (PLAUSIBLE.test(m[2]!)) dynamic.add(m[2]!);
  const any = /\b(?:from|import)(['"])([^'"\n]+)\1/g;
  while ((m = any.exec(source))) if (PLAUSIBLE.test(m[2]!)) all.add(m[2]!);
  return { static: [...all].filter((s) => !dynamic.has(s)), dynamic: [...dynamic] };
}

test('the browser entry resolves nothing and reaches React only through a dynamic import', () => {
  expect(
    existsSync(join(BROWSER, 'index.js')),
    'dist/browser/index.js is missing — has browserEntry.outDir moved?',
  ).toBe(true);

  // Every emitted specifier in EVERY chunk of this build is relative. One bare
  // specifier is a page that 404s — or, for `modern-screenshot`, a capture that
  // silently degrades to a 1x1 placeholder — on a host with no import map,
  // which is this artifact's entire audience. Dropping `noExternal` from
  // browserEntry is what puts one back.
  const bare: string[] = [];
  for (const f of readdirSync(BROWSER).filter((f) => f.endsWith('.js'))) {
    const spec = emittedSpecifiers(readFileSync(join(BROWSER, f), 'utf8'));
    for (const s of [...spec.static, ...spec.dynamic]) {
      if (!s.startsWith('./') && !s.startsWith('../')) bare.push(`${f} -> ${s}`);
    }
  }
  expect(bare, 'the browser build emits a bare specifier a plain page cannot resolve').toEqual([]);

  const entry = emittedSpecifiers(readFileSync(join(BROWSER, 'index.js'), 'utf8'));
  const REACT = /react-dom|__SECRET_INTERNALS/;

  // `splitting: false` inlines the island into the entry: no lazy sibling at
  // all, and React lands in the always-loaded graph. This is the static half of
  // script-tag-mount.spec.ts's runtime assertion.
  const lazyWithReact = entry.dynamic.filter((s) =>
    REACT.test(readFileSync(join(BROWSER, s), 'utf8')),
  );
  expect(lazyWithReact.length, 'no lazily-imported sibling chunk contains React').toBeGreaterThan(
    0,
  );

  // Transitively eager = the entry plus everything reachable from it by STATIC
  // import. None of it may carry React.
  const eager = new Set<string>(['index.js']);
  for (const queue = ['index.js']; queue.length; ) {
    const f = queue.shift()!;
    for (const s of emittedSpecifiers(readFileSync(join(BROWSER, f), 'utf8')).static) {
      const name = s.replace(/^\.\//, '');
      if (!eager.has(name)) {
        eager.add(name);
        queue.push(name);
      }
    }
  }
  for (const f of eager) {
    const body = readFileSync(join(BROWSER, f), 'utf8');
    expect(REACT.test(body), `${f} is eager and contains React`).toBe(false);
  }

  // Sanity, LAST so it never pre-empts the two findings above: the extractor
  // still matches something. Without it, an extractor that silently stopped
  // working would make the bare-specifier check vacuously green.
  expect(
    entry.static.length + entry.dynamic.length,
    'the extractor found no specifier at all in the entry',
  ).toBeGreaterThan(0);

  // eslint-disable-next-line no-console
  console.log(
    `[browser-entry] eager ${[...eager].join(', ')} | react in ${lazyWithReact.join(', ')}`,
  );
});

test('both splitting builds contain complete relative import graphs in their own directories', () => {
  // Bundling both patched capture dependencies can make the ESM and browser
  // entries byte-identical. Completeness matters; differing bytes no longer do.
  for (const directory of [DIST, BROWSER]) {
    expect(existsSync(join(directory, 'index.js')), `${directory}/index.js is missing`).toBe(true);
    for (const file of readdirSync(directory).filter((f) => f.endsWith('.js'))) {
      const imports = specifiers(readFileSync(join(directory, file), 'utf8'));
      for (const dependency of [...imports.static, ...imports.dynamic]) {
        if (dependency.startsWith('./')) {
          expect(existsSync(join(directory, dependency)), `${file} cannot load ${dependency}`).toBe(true);
        }
      }
    }
  }
});
