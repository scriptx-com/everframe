// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { draftToEnvelope, type CaptureBundle } from '../../src/transport/draft-to-envelope.js';
import type { ReportDraft, UserMetadata } from '@everframe/sdk-core';
import type { WebEverframeConfig } from '../../src/internal/types.js';

// Fixture shapes mirror draft-to-envelope.spec.ts's baseConfig/baseBundle/baseDraft
// (this package has no shared __helpers__ module to import from).

function baseConfig(): WebEverframeConfig {
  return {
    apiKey: 'txx_live_test',
    appName: 'test-app',
    appVersion: '1.0.0',
  };
}

function baseBundle(): CaptureBundle {
  return {
    screenshotBlob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    screenshotSha256: 'a'.repeat(64),
    screenshotWidth: 100,
    screenshotHeight: 100,
    focused: null,
    logs: [],
    network: [],
    metadata: {
      os: 'macOS',
      osVersion: '14.0',
      screenSize: { width: 1, height: 1 },
      pixelRatio: 1,
      locale: 'en',
      timezone: 'UTC',
    },
  };
}

const baseDraft: ReportDraft = {
  title: 'X',
  description: 'Y',
  excludedArtifacts: [],
  annotations: [],
  redactions: [],
};

describe('draftToEnvelope user threading', () => {
  it('emits reporter.user when a user is active', () => {
    const user: UserMetadata = { id: 'u_1', email: 'a@b.com' };
    const { envelope } = draftToEnvelope(baseDraft, baseBundle(), baseConfig(), '1.0.0', user);
    expect(envelope.reporter.user).toEqual({ id: 'u_1', email: 'a@b.com' });
  });

  it('omits reporter.user when none is active (undefined)', () => {
    const { envelope } = draftToEnvelope(baseDraft, baseBundle(), baseConfig(), '1.0.0');
    expect(envelope.reporter.user).toBeUndefined();
  });

  it('omits reporter.user (key absent, not present-and-null) when explicitly signed out', () => {
    const { envelope } = draftToEnvelope(baseDraft, baseBundle(), baseConfig(), '1.0.0', null);
    expect(envelope.reporter.user).toBeUndefined();
    expect('user' in envelope.reporter).toBe(false);
  });
});
