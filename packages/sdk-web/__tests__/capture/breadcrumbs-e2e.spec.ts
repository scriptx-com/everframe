// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Full web slice, no React: install the real capture installers against a real
// sdk-core buffer, generate one event per auto kind, freeze (reporter-open),
// takeFrozen (submit), build the envelope, and prove it parses with the chain
// aboard. This is the spec §9 phase-C acceptance in one spec.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createBreadcrumbBuffer } from '@everframe/sdk-core';
import type { ReportDraft } from '@everframe/sdk-core';
import { ReportEnvelope } from '@everframe/protocol';
import {
  installNavigationCrumbs,
  installLifecycleCrumbs,
  installTapCrumbs,
} from '../../src/capture/breadcrumbs.js';
import { installConsolePatcher } from '../../src/capture/logs.js';
import { installFetchPatcher } from '../../src/capture/network.js';
import { __claimCaptureBuffers, consoleBuffer, networkBuffer } from '../../src/capture/buffers.js';
import { draftToEnvelope, type CaptureBundle } from '../../src/transport/draft-to-envelope.js';

const uninstalls: Array<() => void> = [];
afterEach(() => {
  while (uninstalls.length) uninstalls.pop()!();
  __claimCaptureBuffers(100, 100);
  consoleBuffer.clear();
  networkBuffer.clear();
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('breadcrumbs E2E slice (capture → envelope)', () => {
  it('captures all auto kinds, freezes at open, and ships a parsing envelope', async () => {
    const buf = createBreadcrumbBuffer();
    const sink = buf.add.bind(buf);
    const gate = () => true;
    uninstalls.push(installNavigationCrumbs(sink, gate));
    uninstalls.push(installLifecycleCrumbs(sink, gate));
    uninstalls.push(installTapCrumbs(sink, gate, () => []));
    uninstalls.push(installConsolePatcher({ crumbSink: sink, crumbGate: gate }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    uninstalls.push(installFetchPatcher({ crumbSink: sink, crumbGate: gate }));

    // One event per auto kind.
    history.pushState(null, '', '/checkout');
    document.body.innerHTML = '<button id="pay">Pay</button>';
    document.querySelector('#pay')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    console.warn('inventory low');
    await fetch('/api/pay', { method: 'POST' });
    document.dispatchEvent(new Event('visibilitychange'));

    // Reporter opens → freeze. Reporter's own tap must NOT enter the snapshot.
    buf.freeze();
    document.querySelector('#pay')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    const frozen = buf.takeFrozen()!;
    const kinds = new Set(frozen.map((c) => c.kind));
    for (const k of ['navigation', 'tap', 'console', 'network', 'lifecycle'] as const) {
      expect(kinds.has(k), `missing kind: ${k}`).toBe(true);
    }
    expect(frozen.filter((c) => c.kind === 'tap')).toHaveLength(1); // post-freeze tap excluded

    const draft: ReportDraft = {
      title: 't', description: 'd', excludedArtifacts: [], annotations: [], redactions: [],
    };
    const bundle: CaptureBundle = {
      screenshotBlob: null, screenshotSha256: null, screenshotWidth: 0, screenshotHeight: 0,
      focused: null, logs: [], network: [], metadata: null,
      breadcrumbs: frozen,
      breadcrumbTrim: { byteBudget: 16384, consoleEntryCap: 1024 },
    };
    const { envelope } = draftToEnvelope(draft, bundle, { apiKey: 'k' }, '1.0.0');
    expect(envelope.captures['breadcrumbs']).toBe(true);
    expect(envelope.payload.breadcrumbs!.length).toBe(frozen.length);
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
  });
});
