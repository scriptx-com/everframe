// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import {
  deriveLogsFromBreadcrumbs,
  deriveNetworkFromBreadcrumbs,
} from '../src/breadcrumbs/derive.js';
import { buildEnvelope, type BuildEnvelopeInput } from '../src/envelope-builder.js';
import { ReportEnvelope, type Breadcrumb } from '@traceitx/protocol';

const chain: Breadcrumb[] = [
  { t: 1000, seq: 0, kind: 'navigation', message: '/a → /b', data: { from: '/a', to: '/b' } },
  { t: 2000, seq: 1, kind: 'console', level: 'warn', message: 'low stock' },
  { t: 2500, seq: 2, kind: 'console', level: 'info', message: '+3 console hidden', data: { droppedCount: 3 } },
  { t: 3000, seq: 3, kind: 'network', level: 'error', message: 'POST /api/x 500',
    data: { method: 'POST', url: '/api/x', status: 500, durationMs: 42 } },
];

describe('deriveLogsFromBreadcrumbs', () => {
  it('maps console crumbs to LogEntry, excluding trim markers', () => {
    expect(deriveLogsFromBreadcrumbs(chain)).toEqual([
      { level: 'warn', message: 'low stock', timestamp: 2000 },
    ]);
  });

  it('defaults a level-less console crumb to level log', () => {
    expect(deriveLogsFromBreadcrumbs([{ t: 1, seq: 0, kind: 'console', message: 'x' }])).toEqual([
      { level: 'log', message: 'x', timestamp: 1 },
    ]);
  });
});

describe('deriveNetworkFromBreadcrumbs', () => {
  it('maps network crumbs to NetworkEntry from data', () => {
    expect(deriveNetworkFromBreadcrumbs(chain)).toEqual([
      { method: 'POST', url: '/api/x', status: 500, durationMs: 42, startedAt: 3000 },
    ]);
  });

  it('excludes network trim markers from derivation', () => {
    const withMarker: Breadcrumb[] = [
      { t: 3000, seq: 0, kind: 'network', level: 'info', message: '+2 network hidden', data: { droppedCount: 2 } },
      { t: 3500, seq: 1, kind: 'network', level: 'error', message: 'GET /api/y 500',
        data: { method: 'GET', url: '/api/y', status: 500, durationMs: 10 } },
    ];
    expect(deriveNetworkFromBreadcrumbs(withMarker)).toEqual([
      { method: 'GET', url: '/api/y', status: 500, durationMs: 10, startedAt: 3500 },
    ]);
  });
});

const baseInput = (): BuildEnvelopeInput => ({
  reportId: '7b9f4c2e-8d31-4a6b-9c05-2f1e6a8d4b70',
  submittedAt: '2026-07-07T12:00:00.000Z',
  sdk: { name: 'traceitx-react', version: '0.0.0', platform: 'web', formFactor: 'desktop' },
  reporter: { title: 't', description: 'd' },
  draft: { title: 't', description: 'd', excludedArtifacts: [], annotations: [], redactions: [] },
  device: {
    os: 'macOS', osVersion: '15', screenSize: { width: 1, height: 1 },
    pixelRatio: 1, locale: 'en-US', timezone: 'UTC',
  },
  app: { name: 'app', version: '1.0.0' },
  attachments: [],
});

describe('buildEnvelope with breadcrumbs', () => {
  it('trims, ships payload.breadcrumbs, flags captures, and derives legacy logs/network', () => {
    const env = buildEnvelope({ ...baseInput(), breadcrumbs: chain });
    expect(env.payload.breadcrumbs).toHaveLength(4);
    expect(env.captures['breadcrumbs']).toBe(true);
    expect(env.captureControl.included).toContain('breadcrumbs');
    // Deprecation window: legacy arrays derived from the SAME chain.
    expect(env.payload.logs).toEqual([{ level: 'warn', message: 'low stock', timestamp: 2000 }]);
    expect(env.payload.network).toEqual([
      { method: 'POST', url: '/api/x', status: 500, durationMs: 42, startedAt: 3000 },
    ]);
    expect(env.captures.logs).toBe(true);
    expect(env.captures.network).toBe(true);
    expect(ReportEnvelope.safeParse(env).success).toBe(true);
  });

  it('respects excludedArtifacts: breadcrumbs excluded ⇒ nothing shipped or derived', () => {
    const input = { ...baseInput(), breadcrumbs: chain };
    input.draft.excludedArtifacts = ['breadcrumbs'];
    const env = buildEnvelope(input);
    expect(env.payload.breadcrumbs).toBeUndefined();
    expect(env.captures['breadcrumbs']).toBe(false);
    expect(env.payload.logs).toBeUndefined();
  });

  it('explicit input.logs wins over derivation (no double-source)', () => {
    const logs = [{ level: 'error' as const, message: 'direct', timestamp: 5 }];
    const env = buildEnvelope({ ...baseInput(), breadcrumbs: chain, logs });
    expect(env.payload.logs).toEqual(logs);
  });

  it('explicit input.network wins over derivation (no double-source)', () => {
    const network = [{ method: 'PUT', url: '/api/direct', status: 204, startedAt: 9 }];
    const env = buildEnvelope({ ...baseInput(), breadcrumbs: chain, network });
    expect(env.payload.network).toEqual(network);
  });

  // Regression pin: commit 3fa0bb59 changed the payload spread for logs/network
  // from unconditional (`...(input.logs ? {...} : {})`) to gated on inclusion
  // (`...(logs && includedArtifacts.includes('logs') ? {...} : {})`). Previously,
  // excludedArtifacts only flipped the `captures.logs`/`captures.network` flags
  // to false while still shipping the explicitly-passed arrays in payload — a
  // privacy bug (a reporter who excluded logs/network still had that data ride
  // along). The new behavior is intentional and correct: exclusion now strips
  // explicitly-passed legacy arrays from the payload too.
  it('excludedArtifacts strips explicitly-passed legacy logs/network from the payload', () => {
    const logs = [{ level: 'error' as const, message: 'direct log', timestamp: 5 }];
    const network = [{ method: 'GET', url: '/api/direct', status: 200, startedAt: 9 }];
    const input = { ...baseInput(), logs, network };
    input.draft.excludedArtifacts = ['logs', 'network'];
    const env = buildEnvelope(input);
    expect(env.payload.logs).toBeUndefined();
    expect(env.payload.network).toBeUndefined();
    expect(env.captures.logs).toBe(false);
    expect(env.captures.network).toBe(false);
    expect(env.captureControl.included).not.toContain('logs');
    expect(env.captureControl.included).not.toContain('network');
  });

  it('omits breadcrumbs entirely when input has none (pre-breadcrumb callers unchanged)', () => {
    const env = buildEnvelope(baseInput());
    expect(env.payload.breadcrumbs).toBeUndefined();
    expect(env.captures['breadcrumbs']).toBe(false);
    expect(ReportEnvelope.safeParse(env).success).toBe(true);
  });

  it('applies the byte budget via breadcrumbTrim', () => {
    const noisy: Breadcrumb[] = Array.from({ length: 20 }, (_, i) => ({
      t: i, seq: i, kind: 'console', message: 'c'.repeat(100),
    }));
    const env = buildEnvelope({
      ...baseInput(), breadcrumbs: noisy, breadcrumbTrim: { byteBudget: 400 },
    });
    const shipped = env.payload.breadcrumbs!;
    expect(shipped.length).toBeLessThan(20);
    expect(shipped.some((c: any) => c.data?.droppedCount > 0)).toBe(true);
  });
});
