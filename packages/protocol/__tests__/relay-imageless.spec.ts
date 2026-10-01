// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Smart-TV snapshot path (spec 2026-09-29 §Capture contract): every capture
// request gets exactly one completion, and two of those completions carry no
// image bytes. Old frames must keep parsing unchanged.
import { describe, expect, it } from 'vitest';
import { relay } from '../src/index.js';

const SHA = 'a'.repeat(64);
const assembled = {
  type: 'report.assembled',
  correlation_id: 'c1',
  mime: 'image/webp',
  toggles: { logs: true, network: true, uiTree: false, metadata: true, screenshot: true },
  counts: { logs: 0, network: 0, uiTreeNodes: 0 },
} as const;
const redaction = { cropped: false, blurred: false, area_selected: false };
const submit = {
  type: 'report.submit',
  correlation_id: 'c1',
  title: 't',
  description: { text: '', redactions: [] },
  annotations: [],
  includes: { logs: true, network: true, uiTree: false, metadata: true, screenshot: true },
} as const;

describe('report.assembled capture outcomes', () => {
  it('still parses a legacy image frame that names no outcome', () => {
    expect(relay.RelayMessage.parse({ ...assembled, size: 10 })).toMatchObject({ size: 10 });
  });

  it('carries an optional degraded_reason on an image frame', () => {
    const m = relay.RelayMessage.parse({ ...assembled, size: 10, degraded_reason: 'screenshot_blank' });
    expect(m).toMatchObject({ degraded_reason: 'screenshot_blank' });
  });

  it('accepts a snapshot-only frame: no bytes, a snapshot reference, the render failure', () => {
    const m = relay.RelayMessage.parse({
      ...assembled,
      size: 0,
      outcome: 'snapshot',
      degraded_reason: 'screenshot_render_failed',
      snapshot: { byte_length: 2048, sha256: SHA },
    });
    expect(m).toMatchObject({ outcome: 'snapshot', size: 0, snapshot: { byte_length: 2048, sha256: SHA } });
  });

  it('accepts an unavailable frame carrying screenshot_unavailable', () => {
    const m = relay.RelayMessage.parse({
      ...assembled,
      size: 0,
      outcome: 'unavailable',
      degraded_reason: 'screenshot_unavailable',
    });
    expect(m).toMatchObject({ outcome: 'unavailable' });
  });

  it.each([
    ['an image outcome announcing no bytes', { size: 0 }],
    ['an explicit image outcome announcing no bytes', { size: 0, outcome: 'image' }],
    ['an image-less outcome announcing bytes', { size: 5, outcome: 'unavailable', degraded_reason: 'screenshot_unavailable' }],
    ['a snapshot outcome without its reference', { size: 0, outcome: 'snapshot', degraded_reason: 'screenshot_render_failed' }],
    ['an unavailable outcome without a reason', { size: 0, outcome: 'unavailable' }],
    ['a snapshot reference on an image outcome', { size: 5, snapshot: { byte_length: 1, sha256: SHA } }],
    ['a malformed snapshot hash', { size: 0, outcome: 'snapshot', degraded_reason: 'x', snapshot: { byte_length: 1, sha256: 'nope' } }],
  ])('rejects %s', (_label, extra) => {
    expect(relay.RelayMessage.safeParse({ ...assembled, ...extra }).success).toBe(false);
  });
});

describe('report.submit per-shot state', () => {
  it('keeps a legacy submit (no primary_shot, no per-shot fields) valid', () => {
    expect(relay.RelayMessage.safeParse(submit).success).toBe(true);
  });

  it('accepts includes.screenshot false', () => {
    const m = relay.RelayMessage.parse({ ...submit, includes: { ...submit.includes, screenshot: false } });
    expect(m).toMatchObject({ includes: { screenshot: false } });
  });

  it('accepts an image-less primary with explicit redaction state', () => {
    const m = relay.RelayMessage.parse({ ...submit, primary_shot: { has_image: false, redaction } });
    expect(m).toMatchObject({ primary_shot: { has_image: false, redaction } });
  });

  it('accepts per-shot has_image and redaction on extra shots', () => {
    const m = relay.RelayMessage.parse({
      ...submit,
      shots: [{ shot_id: 's1', annotations: [], has_image: true, redaction: { ...redaction, cropped: true } }],
    });
    expect(m).toMatchObject({ shots: [{ shot_id: 's1', has_image: true, redaction: { cropped: true } }] });
  });

  it('rejects a redaction state missing area_selected', () => {
    const bad = { ...submit, primary_shot: { has_image: true, redaction: { cropped: false, blurred: false } } };
    expect(relay.RelayMessage.safeParse(bad).success).toBe(false);
  });

  it('exports CaptureOutcome and ShotRedaction for consumers', () => {
    expect(relay.CaptureOutcome.options).toEqual(['image', 'snapshot', 'unavailable']);
    expect(relay.ShotRedaction.parse(redaction)).toEqual(redaction);
  });
});
