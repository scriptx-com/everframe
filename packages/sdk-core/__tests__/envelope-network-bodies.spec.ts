// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { buildEnvelope } from '../src/envelope-builder.js';
import type { NetworkBodyEntry, Breadcrumb } from '@traceitx/protocol';

const base = {
  reportId: '00000000-0000-4000-8000-000000000000',
  submittedAt: new Date(0).toISOString(),
  sdk: { name: 'traceitx-react', version: '0.0.0', platform: 'web', formFactor: 'desktop' } as const,
  reporter: { title: 't', description: 'd' },
  draft: { title: 't', description: 'd', excludedArtifacts: [], annotations: [], redactions: [] },
  device: { os: 'x', osVersion: '1', screenSize: { width: 1, height: 1 }, pixelRatio: 1, locale: 'en', timezone: 'UTC' },
  app: { name: 'a', version: '1' },
  attachments: [],
};

/** A shipped `network` crumb carrying `data.reqId` — the F14 linkage filter
 *  only lets a body through when one of these exists for its `ref` in the
 *  final trimmed breadcrumb chain. */
function networkCrumb(reqId: number, seq: number): Breadcrumb {
  return {
    t: 1,
    seq,
    kind: 'network',
    level: 'info',
    message: `GET https://example.com ${reqId}`,
    data: { reqId },
  };
}

describe('buildEnvelope networkBodies channel', () => {
  it('attaches payload.networkBodies + marks it included', () => {
    const bodies: NetworkBodyEntry[] = [{ ref: 1, t: 1, resBody: '{"ok":true}' }];
    const crumbs = [networkCrumb(1, 0)];
    const env = buildEnvelope({ ...base, networkBodies: bodies, breadcrumbs: crumbs });
    expect(env.payload.networkBodies).toEqual(bodies);
    expect(env.captureControl.included).toContain('networkBodies');
  });

  it('omits the channel when no bodies and does not mark it included', () => {
    const env = buildEnvelope({ ...base });
    expect(env.payload.networkBodies).toBeUndefined();
    expect(env.captureControl.included).not.toContain('networkBodies');
  });

  it('drops the channel when the reporter excluded network', () => {
    const bodies: NetworkBodyEntry[] = [{ ref: 1, t: 1, resBody: 'x' }];
    const crumbs = [networkCrumb(1, 0)];
    const env = buildEnvelope({
      ...base,
      draft: { ...base.draft, excludedArtifacts: ['network'] },
      networkBodies: bodies,
      breadcrumbs: crumbs,
    });
    expect(env.payload.networkBodies).toBeUndefined();
  });

  // ==================== F14: crumb<->body linkage (spec §10 test 8) ====================

  it('no breadcrumbs supplied - bodies present - networkBodies absent and no marker', () => {
    const bodies: NetworkBodyEntry[] = [{ ref: 1, t: 1, resBody: 'x' }, { ref: 2, t: 2, resBody: 'y' }];
    const env = buildEnvelope({ ...base, networkBodies: bodies });
    expect(env.payload.networkBodies).toBeUndefined();
    expect(env.captureControl.included).not.toContain('networkBodies');
  });

  it('breadcrumbs excluded - bodies present - networkBodies absent and no marker', () => {
    const bodies: NetworkBodyEntry[] = [{ ref: 1, t: 1, resBody: 'x' }];
    const crumbs = [networkCrumb(1, 0)];
    const env = buildEnvelope({
      ...base,
      draft: { ...base.draft, excludedArtifacts: ['breadcrumbs'] },
      networkBodies: bodies,
      breadcrumbs: crumbs,
    });
    expect(env.payload.networkBodies).toBeUndefined();
    expect(env.captureControl.included).not.toContain('networkBodies');
  });

  it('breadcrumbs present but no network-kind crumb - bodies present - networkBodies absent', () => {
    const bodies: NetworkBodyEntry[] = [{ ref: 1, t: 1, resBody: 'x' }];
    const crumbs: Breadcrumb[] = [
      { t: 1, seq: 0, kind: 'console', level: 'info', message: 'log line' },
    ];
    const env = buildEnvelope({ ...base, networkBodies: bodies, breadcrumbs: crumbs });
    expect(env.payload.networkBodies).toBeUndefined();
    expect(env.captureControl.included).not.toContain('networkBodies');
  });

  it('partial crumb match - only matching bodies encode - orphan dropped', () => {
    const bodies: NetworkBodyEntry[] = [
      { ref: 1, t: 1, resBody: 'a' },
      { ref: 2, t: 2, resBody: 'b' },
      { ref: 3, t: 3, resBody: 'c' }, // orphan — no matching crumb below
    ];
    const crumbs = [networkCrumb(1, 0), networkCrumb(2, 1)];
    const env = buildEnvelope({ ...base, networkBodies: bodies, breadcrumbs: crumbs });
    expect(env.payload.networkBodies).toHaveLength(2);
    expect(env.payload.networkBodies?.map((b) => b.ref).sort()).toEqual([1, 2]);
    expect(env.captureControl.included).toContain('networkBodies');
  });

  it('every body matched - all encode and invariant holds', () => {
    const bodies: NetworkBodyEntry[] = [
      { ref: 10, t: 1, resBody: 'a' },
      { ref: 20, t: 2, resBody: 'b' },
      { ref: 30, t: 3, resBody: 'c' },
    ];
    const crumbs = [networkCrumb(10, 0), networkCrumb(20, 1), networkCrumb(30, 2)];
    const env = buildEnvelope({ ...base, networkBodies: bodies, breadcrumbs: crumbs });
    expect(env.payload.networkBodies).toHaveLength(3);
    expect(env.captureControl.included).toContain('networkBodies');

    // Direct invariant assertion: every shipped ref matches EXACTLY ONE
    // shipped network crumb's data.reqId.
    const shippedNetworkReqIds = (env.payload.breadcrumbs ?? [])
      .filter((c) => c.kind === 'network')
      .map((c) => c.data?.['reqId'])
      .filter((v): v is number => typeof v === 'number');
    for (const b of env.payload.networkBodies ?? []) {
      const matches = shippedNetworkReqIds.filter((reqId) => reqId === b.ref);
      expect(matches).toHaveLength(1);
    }
  });
});
