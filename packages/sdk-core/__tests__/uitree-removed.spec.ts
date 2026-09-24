// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// UI-tree capture is gone (tap-to-identify removal). `captures.uiTree` is
// nonetheless a REQUIRED boolean in the protocol schema, so buildEnvelope must
// keep emitting it — as a constant `false`. Dropping the key would make every
// envelope fail validation at ingest.
import { describe, it, expect } from 'vitest';
import { buildEnvelope } from '../src/envelope-builder.js';
import { ReportEnvelope } from '@everframe/protocol';

const baseInput = {
  reportId: '01939c34-7b8f-7000-8000-000000000001',
  submittedAt: '2026-04-29T16:00:00.000Z',
  sdk: {
    name: 'everframe-react' as const,
    version: '0.0.0',
    platform: 'web' as const,
    formFactor: 'desktop' as const,
  },
  reporter: { title: 'T', description: 'D' },
  draft: {
    title: 'T',
    description: 'D',
    excludedArtifacts: [],
    annotations: [],
    redactions: [],
  },
  device: {
    os: 'macos',
    osVersion: '14.4',
    screenSize: { width: 1920, height: 1080 },
    pixelRatio: 2,
    locale: 'en-US',
    timezone: 'America/New_York',
  },
  app: { name: 'app', version: '1.0.0' },
  attachments: [],
};

describe('UI-tree capture removal', () => {
  it('emits captures.uiTree as false and omits payload.uiTree', () => {
    const env = buildEnvelope(baseInput);
    expect(env.captures.uiTree).toBe(false);
    expect(env.payload.uiTree).toBeUndefined();
    expect(env.captureControl.included).not.toContain('uiTree');
  });

  it('still validates against the protocol schema', () => {
    expect(ReportEnvelope.safeParse(buildEnvelope(baseInput)).success).toBe(true);
  });

  it('keeps captures.uiTree false even when the reporter excluded the tree', () => {
    const env = buildEnvelope({
      ...baseInput,
      draft: { ...baseInput.draft, excludedArtifacts: ['uiTree'] },
    });
    expect(env.captures.uiTree).toBe(false);
    expect(ReportEnvelope.safeParse(env).success).toBe(true);
  });
});
