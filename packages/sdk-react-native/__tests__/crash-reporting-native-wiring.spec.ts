// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Source pins for the iOS polarity flip; Android behaviour is covered by EverframeModuleConfigureTest.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), 'utf8');

describe('crashReportingDisabled native wiring', () => {
  it('the iOS module reads the flat flag and forwards it', () => {
    const mm = read('ios', 'Sources', 'EverframeModule.mm');
    expect(mm).toMatch(/BOOL crashReportingDisabled = opts\.crashReportingDisabled\(\)\.value_or\(false\);/);
    expect(mm).toMatch(/crashReportingDisabled:crashReportingDisabled/);
  });
  it('the iOS bridge flips polarity exactly once into capture.crash', () => {
    expect(read('ios', 'Sources', 'EverframeBridge.swift')).toMatch(/cfg\.capture\.crash\s*=\s*!crashReportingDisabled\b/);
  });
  it('the Android module flips polarity exactly once into capture.crash', () => {
    expect(read('android', 'src', 'main', 'java', 'dev', 'everframe', 'rn', 'EverframeModule.kt'))
      .toMatch(/crash\s*=\s*!crashReportingDisabled\b/);
  });
});
