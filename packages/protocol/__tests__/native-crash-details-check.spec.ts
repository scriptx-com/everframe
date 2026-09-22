// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

// Synthetic inputs test the verifier only; SDK proof comes from the native exporter.
it('checks native export shape, required cases, limits and decoded semantics', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'traceitx-details-check-'));
  const file = path.join(dir, 'cases.json');
  const run = (input: unknown) => {
    writeFileSync(file, JSON.stringify(input));
    return spawnSync(
      process.execPath,
      ['scripts/check-native-crash-details.mjs', file],
      { encoding: 'utf8' },
    );
  };
  const cases = [
    'normal',
    'expanding-redactor',
    'repaired-text',
    'capped',
    'prototype-keys',
    'numeric-boundary',
  ].map((name) => ({
    name,
    detailsJson: name === 'numeric-boundary'
      ? '{"severity":"warning","metadata":{"number":1e+20},"truncated":true}'
      : '{"severity":"warning","metadata":{"__proto__":{"ok":true},"sibling":2}}',
  }));
  try {
    expect(run({ schemaVersion: 1, cases }).status).toBe(0);
    for (const input of [
      { schemaVersion: 2, cases },
      { schemaVersion: 1, cases: cases.slice(1) },
      { schemaVersion: 1, cases: [...cases, cases[0]] },
      { schemaVersion: 1, cases, extra: true },
      {
        schemaVersion: 1,
        cases: cases.map((c) => ({ ...c, detailsJson: '{"unknown":true}' })),
      },
      {
        schemaVersion: 1,
        cases: cases.map((c) => ({
          ...c,
          detailsJson: JSON.stringify({
            metadata: { value: 'x'.repeat(9000) },
          }),
        })),
      },
      {
        schemaVersion: 1,
        cases: cases.map(c => c.name === 'numeric-boundary' ? {
          ...c,
          detailsJson: `{"severity":"error","metadata":{"a":[${Array(100).fill('1e+20').join(',')}],"z":[${Array(7).fill(`"${'x'.repeat(1024)}"`).join(',')}]}}`,
        } : c),
      },
    ])
      expect(run(input).status).not.toBe(0);
    expect(
      spawnSync(process.execPath, [
        'scripts/check-native-crash-details.mjs',
        path.join(dir, 'absent'),
      ]).status,
    ).not.toBe(0);
    expect(
      spawnSync(process.execPath, ['scripts/check-native-crash-details.mjs'])
        .status,
    ).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
