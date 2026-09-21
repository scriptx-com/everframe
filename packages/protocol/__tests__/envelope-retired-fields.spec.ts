// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { ReportEnvelope } from '../src/index.js';
import minimal from './fixtures/v1-minimal.json';

describe('retired envelope payload fields', () => {
  it.each(['uiTree', 'reactTree', 'reportTarget'])('%s is no longer a supported payload field', (field) => {
    expect(ReportEnvelope.shape.payload.keyof().options).not.toContain(field);
  });

  it('treats retired fields as opaque extensions when reading historical reports', () => {
    const payload = {
      ...minimal.payload,
      uiTree: { legacy: true },
      reactTree: { rendererHint: 'retired-renderer' },
      reportTarget: [{ tree: 'retired-tree' }],
      futureExtension: { value: 1 },
    };
    expect(ReportEnvelope.parse({ ...minimal, payload }).payload).toEqual(payload);
  });
});
