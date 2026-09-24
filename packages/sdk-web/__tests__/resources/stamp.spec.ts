// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05, Task 9) — the shared
// envelope-stamping helper. Both the report path
// (transport/draft-to-envelope.ts) and the crash path (adapter.ts's crash
// sink) call this ONE helper. If they ever applied the
// MAX_RESOURCE_SAMPLES cap separately, one would silently drift and start
// producing envelopes the server rejects outright — the same lesson
// stamp-active-vitals.ts records from Codex round-1 finding S2, reapplied
// here for the resources block (a DIFFERENT block — Session Vitals itself
// is untouched by this work).
import { afterEach, describe, expect, it } from 'vitest';
import { buildEnvelope, type BuildEnvelopeInput } from '@everframe/sdk-core';
import { MAX_RESOURCE_SAMPLES } from '@everframe/protocol';
import type { ReportEnvelope } from '@everframe/protocol';
import { stampResources, __setActiveResources } from '../../src/resources/stamp.js';

/** Minimal fixture envelope, built via the same sdk-core builder every real
 *  call site uses — reused (and left otherwise untouched) across the suite. */
function baseEnvelope(): ReportEnvelope {
  const input: BuildEnvelopeInput = {
    reportId: '00000000-0000-4000-8000-000000000000',
    submittedAt: new Date(0).toISOString(),
    sdk: { name: 'everframe-web', version: '0.1.0', platform: 'web', formFactor: 'desktop' },
    reporter: { title: 'X', description: 'Y' },
    draft: { title: 'X', description: 'Y', excludedArtifacts: [], annotations: [], redactions: [] },
    device: {
      os: 'macOS',
      osVersion: '14.0',
      screenSize: { width: 1, height: 1 },
      pixelRatio: 1,
      locale: 'en',
      timezone: 'UTC',
    },
    app: { name: 'test-app', version: '1.0.0' },
    attachments: [],
  };
  return buildEnvelope(input);
}

afterEach(() => {
  __setActiveResources(undefined);
});

describe('stampResources', () => {
  it('stamps payload.resources from the active ring', () => {
    const env = baseEnvelope();
    __setActiveResources({ snapshot: () => [{ t: 1, mem: 10 }] });
    stampResources(env);
    expect(env.payload.resources).toEqual([{ t: 1, mem: 10 }]);
  });

  it('is a no-op when the feature is off', () => {
    const env = baseEnvelope();
    __setActiveResources(undefined);
    stampResources(env);
    expect(env.payload.resources).toBeUndefined();
  });

  // Round-review Finding 4 (2026-09-05) — an active ring with an EMPTY
  // snapshot (report filed within one sample tick of the ring starting, or
  // every sample aged out while the tab was hidden) must OMIT the key
  // entirely, exactly like the "feature is off" case above — never assign
  // `resources: []`. Both natives already omit it for identical underlying
  // state (`EnvelopeBuilder.swift`'s `!resources.isEmpty` guard;
  // `EnvelopeBuilder.kt`'s `if (cappedResources.isEmpty()) null`); a bare
  // assignment here was the one wire-shape web/native could disagree on.
  it('omits the key rather than assigning an empty array when the active ring has no samples yet', () => {
    const env = baseEnvelope();
    __setActiveResources({ snapshot: () => [] });
    stampResources(env);
    expect(env.payload.resources).toBeUndefined();
    expect('resources' in env.payload).toBe(false);
  });

  it('caps at MAX_RESOURCE_SAMPLES keeping the NEWEST samples', () => {
    const env = baseEnvelope();
    const all = Array.from({ length: MAX_RESOURCE_SAMPLES + 10 }, (_, i) => ({ t: i, mem: i }));
    __setActiveResources({ snapshot: () => all });
    stampResources(env);
    expect(env.payload.resources).toHaveLength(MAX_RESOURCE_SAMPLES);
    expect(env.payload.resources!.at(-1)!.t).toBe(MAX_RESOURCE_SAMPLES + 9);
  });

  // Global constraint: Session Vitals is not modified by this work.
  it('leaves payload.vitals untouched', () => {
    const env = baseEnvelope();
    env.payload.vitals = [{ kind: 'sample', t: 1, mem: 5 }];
    __setActiveResources({ snapshot: () => [{ t: 1, mem: 10 }] });
    stampResources(env);
    expect(env.payload.vitals).toEqual([{ kind: 'sample', t: 1, mem: 5 }]);
  });

  it('never throws even when the active box throws', () => {
    const env = baseEnvelope();
    __setActiveResources({
      snapshot: () => {
        throw new Error('boom');
      },
    });
    expect(() => stampResources(env)).not.toThrow();
  });
});
