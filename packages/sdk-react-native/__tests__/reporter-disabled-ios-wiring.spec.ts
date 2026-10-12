// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Source pins for the iOS half of the crash-only switch (spec 2026-10-12): the flat
// `reporterDisabled` flag flips polarity once into `EverframeConfig.reporterEnabled`, and
// `openReporter` rejects a crash-only session with the code the JS facade maps to
// `EverframeReporterDisabledError`.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), 'utf8');
const mm = () => read('ios', 'Sources', 'EverframeModule.mm');
const bridge = () => read('ios', 'Sources', 'EverframeBridge.swift');

describe('reporterDisabled iOS wiring', () => {
  it('the iOS module reads the flat flag, absent meaning a report session, and forwards it', () => {
    expect(mm()).toMatch(/BOOL reporterDisabled = opts\.reporterDisabled\(\)\.value_or\(false\);/);
    expect(mm()).toMatch(/reporterDisabled:reporterDisabled/);
  });

  it('the iOS bridge flips polarity exactly once into reporterEnabled', () => {
    expect(bridge()).toMatch(/reporterDisabled: Bool/);
    expect(bridge()).toMatch(/cfg\.reporterEnabled\s*=\s*!reporterDisabled\b/);
  });

  it('openReporter rejects a crash-only session with EVERFRAME_REPORTER_DISABLED', () => {
    expect(bridge()).toMatch(/catch EverframeReporterError\.reporterDisabled/);
    expect(bridge()).toMatch(/"EVERFRAME_REPORTER_DISABLED"/);
    expect(mm()).toMatch(/reject\(\[EverframeBridge openReporterRejectCodeFor:err\]/);
  });
});
