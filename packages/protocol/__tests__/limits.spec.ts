// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { MAX_INGEST_FILE_PARTS, MAX_REPORT_SHOTS } from '../src/index.js';

describe('report limits', () => {
  it('caps a report at five shots, the cap every reporter UI enforces', () => {
    expect(MAX_REPORT_SHOTS).toBe(5);
  });

  it('budgets the envelope, an image and a dom-snapshot per shot, and one replay', () => {
    expect(MAX_INGEST_FILE_PARTS).toBe(1 + MAX_REPORT_SHOTS * 2 + 1);
    expect(MAX_INGEST_FILE_PARTS).toBe(12);
  });
});
