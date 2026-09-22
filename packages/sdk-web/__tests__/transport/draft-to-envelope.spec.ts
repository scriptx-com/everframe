// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { ReportEnvelope } from '@traceitx/protocol';
import { draftToEnvelope, type CaptureBundle } from '../../src/transport/draft-to-envelope.js';
import type { ReportDraft } from '@traceitx/sdk-core';
import type { WebTraceItXConfig } from '../../src/internal/types.js';

/** Minimal fixture config, reused (and overridden via spread) across the suite. */
function baseConfig(): WebTraceItXConfig {
  return {
    apiKey: 'txx_live_test',
    appName: 'test-app',
    appVersion: '1.0.0',
  };
}

/** Minimal fixture bundle (single legacy screenshot), reused (and overridden via spread)
 *  across the suite — returns a fresh object each call so per-test mutation/spread never
 *  leaks between tests. */
function baseBundle(): CaptureBundle {
  return {
    screenshotBlob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    screenshotSha256: 'a'.repeat(64),
    screenshotWidth: 100,
    screenshotHeight: 100,
    focused: null,
    logs: [
      { level: 'log', message: 'l1', timestamp: 1 },
      { level: 'warn', message: 'l2', timestamp: 2 },
    ],
    network: [
      { method: 'GET', url: 'https://api.example.com', startedAt: 1, status: 200 },
    ],
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

describe('draftToEnvelope', () => {
  it('preserves the deployed app build on user-filed reports', () => {
    const { envelope } = draftToEnvelope(
      baseDraft, baseBundle(), { ...baseConfig(), appBuild: 'web-abc123' }, '0.1.0',
    );
    expect(ReportEnvelope.parse(envelope).context.app).toMatchObject({
      version: '1.0.0', build: 'web-abc123',
    });
  });

  it('produces envelope with sdk.platform=web and sdk.name=traceitx-react + version', () => {
    const { envelope } = draftToEnvelope(baseDraft, baseBundle(), baseConfig(), '0.1.0');
    expect(envelope.sdk.platform).toBe('web');
    expect(envelope.sdk.name).toBe('traceitx-react');
    expect(envelope.sdk.version).toBe('0.1.0');
    // schema round-trip
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
  });

  it('captureControl.included lists every captured artifact when excludedArtifacts is empty', () => {
    const { envelope } = draftToEnvelope(baseDraft, baseBundle(), baseConfig(), '0.1.0');
    expect(envelope.captureControl.included).toEqual(['logs', 'network', 'screenshot']);
    expect(envelope.captureControl.excluded).toEqual([]);
  });

  it('never captures a UI tree, but still emits the required captures.uiTree boolean', () => {
    // UI-tree capture is gone. `captures.uiTree` stays a REQUIRED boolean in
    // the protocol schema, so it must ship as a constant false — dropping the
    // key would fail validation at ingest.
    const { envelope } = draftToEnvelope(baseDraft, baseBundle(), baseConfig(), '0.1.0');
    expect(envelope.captures.uiTree).toBe(false);
    expect(envelope.payload.uiTree).toBeUndefined();
    expect(envelope.captureControl.included).not.toContain('uiTree');
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
  });

  it('captureControl.excluded mirrors draft.excludedArtifacts; payload omits the excluded fields', () => {
    const draft: ReportDraft = { ...baseDraft, excludedArtifacts: ['logs', 'network'] };
    const { envelope } = draftToEnvelope(draft, baseBundle(), baseConfig(), '0.1.0');
    expect(envelope.captureControl.excluded).toEqual(['logs', 'network']);
    expect(envelope.captureControl.included).not.toContain('logs');
    expect(envelope.captureControl.included).not.toContain('network');
    expect(envelope.payload.logs).toBeUndefined();
    expect(envelope.payload.network).toBeUndefined();
  });

  it('Pitfall 8 — when redactions non-empty, only annotated-screenshot ships; no screenshot kind', () => {
    const draft: ReportDraft = {
      ...baseDraft,
      redactions: [{ x: 0, y: 0, width: 1, height: 1, type: 'blur' }],
    };
    const { attachments, envelope } = draftToEnvelope(draft, baseBundle(), baseConfig(), '0.1.0');
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.kind).toBe('annotated-screenshot');
    expect(attachments[0]!.name).toBe('annotated-screenshot');
    expect(envelope.attachments).toHaveLength(1);
    expect(envelope.attachments[0]!.kind).toBe('annotated-screenshot');
    expect(envelope.attachments.find((a) => a.kind === 'screenshot')).toBeUndefined();
  });

  it('Pitfall 8 — when redactions empty, only screenshot ships; no annotated-screenshot kind', () => {
    const { attachments, envelope } = draftToEnvelope(baseDraft, baseBundle(), baseConfig(), '0.1.0');
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.kind).toBe('screenshot');
    expect(attachments[0]!.name).toBe('screenshot');
    expect(envelope.attachments).toHaveLength(1);
    expect(envelope.attachments[0]!.kind).toBe('screenshot');
    expect(envelope.attachments.find((a) => a.kind === 'annotated-screenshot')).toBeUndefined();
  });

  it('captureControl.degradedReason populated from bundle.degradedReason', () => {
    const bundle: CaptureBundle = { ...baseBundle(), degradedReason: 'react_version_unsupported_fiber' };
    const { envelope } = draftToEnvelope(baseDraft, bundle, baseConfig(), '0.1.0');
    expect(envelope.captureControl.degradedReason).toBe('react_version_unsupported_fiber');
  });

  it('redactedLogIndices filters out the redacted rows from envelope.payload.logs', () => {
    const bundle: CaptureBundle = { ...baseBundle(), redactedLogIndices: new Set([0]) };
    const { envelope } = draftToEnvelope(baseDraft, bundle, baseConfig(), '0.1.0');
    const logs = (envelope.payload as { logs?: Array<{ message: string }> }).logs ?? [];
    expect(logs.length).toBe(1);
    expect(logs[0]!.message).toBe('l2');
  });

  it('excludes screenshot attachment when excludedArtifacts contains "screenshot"', () => {
    const draft: ReportDraft = { ...baseDraft, excludedArtifacts: ['screenshot'] };
    const { attachments, envelope } = draftToEnvelope(draft, baseBundle(), baseConfig(), '0.1.0');
    expect(attachments).toHaveLength(0);
    expect(envelope.attachments).toHaveLength(0);
    expect(envelope.captureControl.included).not.toContain('screenshot');
    expect(envelope.captureControl.excluded).toContain('screenshot');
  });
});

describe('draftToEnvelope — multi-screenshot (report-window overhaul)', () => {
  it('emits one attachment per shot with prefix part names, annotated per shot', () => {
    const blobA = new Blob(['a'], { type: 'image/webp' });
    const blobB = new Blob(['b'], { type: 'image/png' });
    const blobC = new Blob(['c'], { type: 'image/webp' });
    const { envelope, attachments } = draftToEnvelope(
      {
        title: 't',
        description: '',
        excludedArtifacts: [],
        annotations: [],
        redactions: [],
      },
      {
        ...baseBundle(), // the file's existing minimal CaptureBundle fixture
        screenshots: [
          { blob: blobA, sha256: 'a'.repeat(64), width: 10, height: 10, annotated: true },
          { blob: blobB, sha256: 'b'.repeat(64), width: 20, height: 20, annotated: false },
          { blob: blobC, sha256: 'c'.repeat(64), width: 30, height: 30, annotated: true },
        ],
      },
      baseConfig(),
      '1.0.0',
    );
    expect(attachments.map((a) => a.name)).toEqual([
      'annotated-screenshot',
      'screenshot-2',
      'annotated-screenshot-3',
    ]);
    expect(envelope.attachments.map((a) => [a.partName, a.kind, a.width])).toEqual([
      ['annotated-screenshot', 'annotated-screenshot', 10],
      ['screenshot-2', 'screenshot', 20],
      ['annotated-screenshot-3', 'annotated-screenshot', 30],
    ]);
  });

  it('falls back to the legacy single-shot fields when bundle.screenshots is absent', () => {
    // Re-run the file's EXISTING single-screenshot assertion path untouched —
    // if those tests still pass this test is satisfied; add it only if the
    // existing suite lacks an explicit partName assertion:
    const { attachments } = draftToEnvelope(
      { title: 't', description: '', excludedArtifacts: [], annotations: [], redactions: [] },
      baseBundle(), // has screenshotBlob/screenshotSha256 set, no .screenshots
      baseConfig(),
      '1.0.0',
    );
    expect(attachments.map((a) => a.name)).toEqual(['screenshot']);
  });

  it('respects excludedArtifacts screenshot switch for ALL shots', () => {
    const { attachments } = draftToEnvelope(
      { title: 't', description: '', excludedArtifacts: ['screenshot'], annotations: [], redactions: [] },
      {
        ...baseBundle(),
        screenshots: [
          { blob: new Blob(['a']), sha256: 'a'.repeat(64), width: 1, height: 1, annotated: false },
          { blob: new Blob(['b']), sha256: 'b'.repeat(64), width: 1, height: 1, annotated: false },
        ],
      },
      baseConfig(),
      '1.0.0',
    );
    expect(attachments.filter((a) => a.kind !== 'session-replay')).toHaveLength(0);
  });
});
