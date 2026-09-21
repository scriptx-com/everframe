// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// A stray Node import here does not fail loudly — it fails at a customer's
// Worker deploy, long after review. This makes it fail in CI instead.
//
// The guard scans raw SOURCE TEXT, not an AST, so comments and string
// literals would otherwise be scanned as if they were code. This file is its
// own proof: a doc comment mentioning `process.env.X!` in prose tripped this
// exact guard during development. `stripComments` removes `//` and `/* */`
// comments (string and template literal contents are left untouched, so a
// URL literal like `http://` is never mistaken for a comment) before either
// pattern below is applied. This is a guard, not a parser — it only needs to
// not choke on the one thing documentation about this very package is
// guaranteed to say.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;
/** The one file permitted to know Node exists, keyed by path relative to SRC
 *  (not the bare basename) so a future `src/adapters/node.ts` cannot widen
 *  the exemption by sharing a filename with the real one. */
const EXEMPT = new Set(['node.ts']);

const NODE_IMPORT_PATTERN = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]node:/;
const PROCESS_REF_PATTERN = /\bprocess\s*\./;

/**
 * Strips line comments and block comments from `src`, leaving string and
 * template literal contents untouched. Deliberately a simple
 * char-by-char scan, not a full parser — good enough to keep comments and
 * string bodies from being misread as either comments or code.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < n && src.charAt(i) !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && src.slice(i, i + 2) !== '*/') i++;
      i += 2;
      continue;
    }
    const c = src.charAt(i);
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < n && src.charAt(i) !== c) {
        if (src.charAt(i) === '\\' && i + 1 < n) {
          out += src.charAt(i) + src.charAt(i + 1);
          i += 2;
          continue;
        }
        out += src.charAt(i);
        i++;
      }
      if (i < n) {
        out += src.charAt(i);
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** True if CODE (comments stripped) statically or dynamically imports a `node:` builtin. */
export function hasNodeImport(src: string): boolean {
  return NODE_IMPORT_PATTERN.test(stripComments(src));
}

/** True if CODE (comments stripped) references `process.*`. */
export function hasProcessRef(src: string): boolean {
  return PROCESS_REF_PATTERN.test(stripComments(src));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!entry.endsWith('.ts')) return [];
    const relToSrc = full.slice(SRC.length + 1);
    return EXEMPT.has(relToSrc) ? [] : [full];
  });
}

describe('edge purity', () => {
  const files = sourceFiles(SRC);

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files.map((f) => [f.slice(SRC.length + 1), f]))(
    '%s imports no node: builtin',
    (_name, file) => {
      expect(hasNodeImport(readFileSync(file, 'utf8'))).toBe(false);
    },
  );

  it.each(files.map((f) => [f.slice(SRC.length + 1), f]))(
    '%s references no process.*',
    (_name, file) => {
      expect(hasProcessRef(readFileSync(file, 'utf8'))).toBe(false);
    },
  );
});

// Real files can only prove the guard passes today — they'd keep passing
// even if stripComments or the patterns above were broken. These exercise
// the scanning logic directly against known-good and known-bad snippets.
describe('purity-scanning helpers', () => {
  it('does not flag process. mentioned only inside a // comment', () => {
    const src = "// an unset process.env.FOO is fine to mention in prose\nconst x = 1;";
    expect(hasProcessRef(src)).toBe(false);
  });

  it('does not flag process. mentioned only inside a /* */ block comment', () => {
    const src = '/* mentions process.env.FOO in prose */\nconst x = 1;';
    expect(hasProcessRef(src)).toBe(false);
  });

  it('flags a real process.env reference in code', () => {
    const src = 'const secret = process.env.FOO;';
    expect(hasProcessRef(src)).toBe(true);
  });

  it('flags a static import of a node: builtin', () => {
    const src = "import { readFileSync } from 'node:fs';";
    expect(hasNodeImport(src)).toBe(true);
  });

  it('flags a dynamic import of a node: builtin', () => {
    const src = "async function f() { await import('node:fs'); }";
    expect(hasNodeImport(src)).toBe(true);
  });

  it('does not mistake a URL string for a comment', () => {
    const src = 'const url = `http://${host}`;\nconst y = 2;';
    const stripped = stripComments(src);
    expect(stripped).toContain('http://');
    expect(stripped).toContain('const y = 2;');
  });
});
