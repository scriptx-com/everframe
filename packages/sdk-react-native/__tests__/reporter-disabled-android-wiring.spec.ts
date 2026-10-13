// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Source pins for the Android crash-only switch (spec 2026-10-12); behaviour is covered by
// EverframeModuleConfigureTest.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const android = () => source('android/src/main/java/dev/everframe/rn/EverframeModule.kt');

describe('reporterDisabled Android wiring', () => {
  it('reads the flat bridge field the facade sends', () => {
    expect(source('src/NativeEverframe.ts')).toMatch(/\breporterDisabled\?: boolean;/);
    expect(android()).toContain(
      'val reporterDisabled = opts.takeIfHasBoolean("reporterDisabled") ?: false',
    );
  });
  it('flips polarity exactly once into reporterEnabled', () => {
    expect(android()).toMatch(/reporterEnabled\s*=\s*!reporterDisabled\b/);
  });
  it('rejects openReporter with the exact code the facade maps to EverframeReporterDisabledError', () => {
    const kt = android();
    expect(kt).toContain('REJECT_REPORTER_DISABLED: String = "EVERFRAME_REPORTER_DISABLED"');
    // Before the reporter bridge, which reduces every core failure to one generic message.
    expect(kt).toMatch(/promise\.reject\(REJECT_REPORTER_DISABLED,[\s\S]*?MainScope\(\)\.launch/);
  });
});
