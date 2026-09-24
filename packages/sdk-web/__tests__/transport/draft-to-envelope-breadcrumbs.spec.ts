// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { ReportEnvelope, type Breadcrumb } from '@everframe/protocol';
import { draftToEnvelope, type CaptureBundle } from '../../src/transport/draft-to-envelope.js';
import type { ReportDraft } from '@everframe/sdk-core';

const draft: ReportDraft = {
  title: 't',
  description: 'd',
  excludedArtifacts: [],
  annotations: [],
  redactions: [],
};

const baseBundle = (): CaptureBundle => ({
  screenshotBlob: null,
  screenshotSha256: null,
  screenshotWidth: 0,
  screenshotHeight: 0,
  focused: null,
  logs: [],
  network: [],
  metadata: null,
});

const chain: Breadcrumb[] = [
  { t: 1000, seq: 0, kind: 'navigation', message: '/a → /b', data: { from: '/a', to: '/b' } },
  { t: 2000, seq: 1, kind: 'tap', message: 'tap Buy now' },
];

describe('draftToEnvelope breadcrumbs', () => {
  it('ships the frozen chain, flags captures, and still parses', () => {
    const { envelope } = draftToEnvelope(
      draft,
      { ...baseBundle(), breadcrumbs: chain },
      { apiKey: 'k' },
      '1.0.0',
    );
    expect(envelope.payload.breadcrumbs).toHaveLength(2);
    expect(envelope.captures['breadcrumbs']).toBe(true);
    expect(envelope.captureControl.included).toContain('breadcrumbs');
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
  });

  it('applies breadcrumbTrim options from the bundle', () => {
    const noisy: Breadcrumb[] = Array.from({ length: 20 }, (_, i) => ({
      t: i, seq: i, kind: 'console', message: 'c'.repeat(100),
    }));
    const { envelope } = draftToEnvelope(
      draft,
      { ...baseBundle(), breadcrumbs: noisy, breadcrumbTrim: { byteBudget: 400 } },
      { apiKey: 'k' },
      '1.0.0',
    );
    expect(envelope.payload.breadcrumbs!.length).toBeLessThan(20);
  });

  it('bundle without breadcrumbs is unchanged (captures.breadcrumbs false)', () => {
    const { envelope } = draftToEnvelope(draft, baseBundle(), { apiKey: 'k' }, '1.0.0');
    expect(envelope.payload.breadcrumbs).toBeUndefined();
    expect(envelope.captures['breadcrumbs']).toBe(false);
  });
});
