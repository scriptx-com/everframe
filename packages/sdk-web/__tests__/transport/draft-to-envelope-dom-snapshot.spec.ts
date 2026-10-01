// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { ReportEnvelope, readCaptureControlRender } from '@everframe/protocol';
import { shotPartName } from '../../src/transport/draft-to-envelope.js';
import type { ReportDraft } from '@everframe/sdk-core';
import { draftToEnvelope, type CaptureBundle } from '../../src/transport/draft-to-envelope.js';

const draft: ReportDraft = { title: 'X', description: 'Y', excludedArtifacts: [], annotations: [], redactions: [] };
const config = { apiKey: 'k', appName: 'tv', appVersion: '1.0.0' };
const SNAP = { bytes: new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2]), sha256: 'b'.repeat(64) };
const RENDER = { platform: 'webos', viewport: { width: 1280, height: 720 }, dpr: 2, fontStatus: 'loaded' } as CaptureBundle['render'];
const png = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });

function bundle(extra: Partial<CaptureBundle>): CaptureBundle {
  return {
    screenshotBlob: null, screenshotSha256: null, screenshotWidth: 0, screenshotHeight: 0,
    focused: null, logs: [], network: [], metadata: null, ...extra,
  };
}

describe('draftToEnvelope — dom-snapshot parts', () => {
  it('ships an image shot and its snapshot under the same shot number', () => {
    const { envelope, attachments } = draftToEnvelope(draft, bundle({
      screenshotBlob: png(), screenshotSha256: 'a'.repeat(64), screenshotWidth: 10, screenshotHeight: 10,
      domSnapshots: [{ shotNumber: 1, ...SNAP }],
    }), config, '0.0.0');
    expect(attachments.map((a) => [a.name, a.kind])).toEqual([['screenshot', 'screenshot'], ['dom-snapshot', 'dom-snapshot']]);
    const ref = envelope.attachments.find((a) => a.partName === 'dom-snapshot')!;
    expect(ref).toMatchObject({ kind: 'dom-snapshot', contentType: 'application/gzip', byteLength: 6, sha256: SNAP.sha256 });
    expect(attachments[1]!.blob.type).toBe('application/gzip');
    expect(() => ReportEnvelope.parse(envelope)).not.toThrow();
  });

  it('keeps numbering aligned when shot 1 is snapshot-only and shot 2 has an image', () => {
    const { attachments } = draftToEnvelope(draft, bundle({
      screenshots: [{ blob: png(), sha256: 'c'.repeat(64), width: 5, height: 5, annotated: false, shotNumber: 2 }],
      domSnapshots: [{ shotNumber: 1, ...SNAP }],
    }), config, '0.0.0');
    expect(attachments.map((a) => a.name)).toEqual(['screenshot-2', 'dom-snapshot']);
  });

  it('names later snapshots dom-snapshot-N', () => {
    const { attachments } = draftToEnvelope(draft, bundle({ domSnapshots: [{ shotNumber: 3, ...SNAP }] }), config, '0.0.0');
    expect(attachments.map((a) => a.name)).toEqual(['dom-snapshot-3']);
  });

  it('drops snapshots with the screenshot artifact when the user excluded it', () => {
    const { attachments } = draftToEnvelope({ ...draft, excludedArtifacts: ['screenshot'] }, bundle({ domSnapshots: [{ shotNumber: 1, ...SNAP }] }), config, '0.0.0');
    expect(attachments).toEqual([]);
  });

  it('stamps captureControl.render only when a snapshot-path shot supplied it', () => {
    const withRender = draftToEnvelope(draft, bundle({ render: RENDER }), config, '0.0.0').envelope;
    // Rides captureControl's passthrough (step-2 R3) — read it the way servers do.
    expect(readCaptureControlRender(ReportEnvelope.parse(withRender))).toEqual(RENDER);
    const without = draftToEnvelope(draft, bundle({}), config, '0.0.0').envelope;
    expect('render' in without.captureControl).toBe(false);
  });

  it('keeps a legacy single-shot bundle byte-identical in naming', () => {
    const { attachments } = draftToEnvelope(draft, bundle({ screenshotBlob: png(), screenshotSha256: 'a'.repeat(64), screenshotWidth: 1, screenshotHeight: 1 }), config, '0.0.0');
    expect(attachments.map((a) => a.name)).toEqual(['screenshot']);
  });

  it('never ships two parts for one shot number (duplicate guard: first wins)', () => {
    const { envelope, attachments } = draftToEnvelope(draft, bundle({
      screenshots: [
        { blob: png(), sha256: 'c'.repeat(64), width: 5, height: 5, annotated: false, shotNumber: 1 },
        { blob: png(), sha256: 'd'.repeat(64), width: 5, height: 5, annotated: true, shotNumber: 1 },
        { blob: png(), sha256: 'f'.repeat(64), width: 5, height: 5, annotated: false, shotNumber: 1 },
      ],
      domSnapshots: [{ shotNumber: 2, ...SNAP }, { shotNumber: 2, ...SNAP, sha256: '9'.repeat(64) }],
    }), config, '0.0.0');
    expect(attachments.map((a) => [a.name, a.sha256[0]])).toEqual([['screenshot', 'c'], ['dom-snapshot-2', 'b']]);
    expect(envelope.attachments.map((a) => a.partName)).toEqual(['screenshot', 'dom-snapshot-2']);
    expect(() => ReportEnvelope.parse(envelope)).not.toThrow();
  });

  it('shotPartName is the one formula for every kind', () => {
    expect(shotPartName('screenshot', 1)).toBe('screenshot');
    expect(shotPartName('annotated-screenshot', 2)).toBe('annotated-screenshot-2');
    expect(shotPartName('dom-snapshot', 1)).toBe('dom-snapshot');
    expect(shotPartName('dom-snapshot', 4)).toBe('dom-snapshot-4');
    expect(() => shotPartName('screenshot', 0)).toThrow(RangeError);
  });
});
