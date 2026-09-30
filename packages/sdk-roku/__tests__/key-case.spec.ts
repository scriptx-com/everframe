// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Static guard for a real-device behaviour the brs-node test interpreter CANNOT
// reproduce: on real Roku OS, an UNQUOTED associative-array literal key
// (`{ fooBar: 1 }`) is stored lowercased (`foobar`), and so is a dotted
// assignment (`aa.fooBar = 1`). Only quoted literal keys (`{ "fooBar": 1 }`)
// and bracket assignment (`aa["fooBar"] = 1`) preserve case. brs-node keeps the
// case either way, so behavioural specs pass while the device sends a
// lowercased envelope that ingest rejects (400 schema_validation_failed).
// This test therefore scans the sources instead.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, createVisitor, WalkMode, isAAMemberExpression, isDottedSetStatement } from 'brighterscript';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');

const ROOTS = [
  path.join(pkgRoot, 'library'),
  path.join(pkgRoot, 'hook'),
  path.join(repoRoot, 'examples', 'roku-channel', 'components'),
  path.join(repoRoot, 'examples', 'roku-channel', 'source'),
];

function brsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...brsFiles(p));
    else if (name.endsWith('.brs')) out.push(p);
  }
  return out;
}

/** Returns "file:line: description" for every case-losing construct. */
export function findCaseLosses(file: string, code: string): string[] {
  const rel = path.relative(repoRoot, file);
  const problems: string[] = [];
  const { ast } = Parser.parse(code);
  ast.walk(
    createVisitor({
      AALiteralExpression: (lit) => {
        for (const el of lit.elements) {
          if (!isAAMemberExpression(el)) continue;
          const text = el.keyToken.text;
          if (text.startsWith('"')) continue; // quoted -> case preserved
          if (/[A-Z]/.test(text)) problems.push(`${rel}:${el.keyToken.range.start.line + 1}: unquoted AA key ${text}`);
        }
      },
      DottedSetStatement: (st) => {
        // functionName is a SceneGraph node field (case-insensitive, never serialized).
        if (isDottedSetStatement(st) && /[A-Z]/.test(st.name.text) && st.name.text !== 'functionName') {
          problems.push(`${rel}:${st.name.range.start.line + 1}: dotted assignment .${st.name.text} =`);
        }
      },
    }),
    { walkMode: WalkMode.visitAllRecursive },
  );
  return problems;
}

describe('AA key case (real Roku lowercases unquoted keys)', () => {
  const files = ROOTS.flatMap(brsFiles);

  it('scans a non-trivial set of files', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it('detector flags unquoted camelCase keys and dotted sets (self-check)', () => {
    const bad = 'sub x()\n  a = { fooBar: 1, "okKey": 2, low: 3 }\n  a.bazQux = 1\n  a["fine"] = 1\nend sub\n';
    expect(findCaseLosses('bad.brs', bad).length).toBe(2);
  });

  it('no unquoted camelCase AA-literal keys or dotted camelCase assignments', () => {
    const all = files.flatMap((f) => findCaseLosses(f, readFileSync(f, 'utf8')));
    expect(all).toEqual([]);
  });
});
