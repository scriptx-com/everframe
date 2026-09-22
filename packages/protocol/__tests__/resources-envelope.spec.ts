// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { ReportEnvelope, MAX_RESOURCE_SAMPLES } from '../src/index.js';
import { baseEnvelope } from './helpers/base-envelope.js';

const sample = (t: number) => ({ t, cpu: 0.5, mem: 1024 });

describe('payload.resources', () => {
  it('accepts an envelope carrying resource samples', () => {
    const env = baseEnvelope();
    env.payload.resources = [sample(1), sample(2)];
    expect(ReportEnvelope.parse(env).payload.resources).toHaveLength(2);
  });

  // Additive-optional: every envelope written before this feature must keep
  // parsing byte-identically.
  it('accepts an envelope with no resources field at all', () => {
    const env = baseEnvelope();
    expect(ReportEnvelope.parse(env).payload.resources).toBeUndefined();
  });

  // All-or-nothing: an over-cap block rejects the WHOLE report, so the cap
  // must bite at the schema boundary.
  it('rejects more than MAX_RESOURCE_SAMPLES entries', () => {
    const env = baseEnvelope();
    env.payload.resources = Array.from({ length: MAX_RESOURCE_SAMPLES + 1 }, (_, i) => sample(i));
    expect(() => ReportEnvelope.parse(env)).toThrow();
  });

  it('accepts exactly MAX_RESOURCE_SAMPLES entries', () => {
    const env = baseEnvelope();
    env.payload.resources = Array.from({ length: MAX_RESOURCE_SAMPLES }, (_, i) => sample(i));
    expect(ReportEnvelope.parse(env).payload.resources).toHaveLength(MAX_RESOURCE_SAMPLES);
  });

  it('rejects a malformed sample inside an otherwise valid envelope', () => {
    const env = baseEnvelope();
    env.payload.resources = [{ t: 1 }];
    expect(() => ReportEnvelope.parse(env)).toThrow();
  });

  // payload.vitals is untouched by this feature — guard against a careless
  // edit to the neighbouring line.
  it('leaves payload.vitals working alongside resources', () => {
    const env = baseEnvelope();
    env.payload.vitals = [{ kind: 'sample', t: 1, mem: 10 }];
    env.payload.resources = [sample(1)];
    const parsed = ReportEnvelope.parse(env);
    expect(parsed.payload.vitals).toHaveLength(1);
    expect(parsed.payload.resources).toHaveLength(1);
  });
});
