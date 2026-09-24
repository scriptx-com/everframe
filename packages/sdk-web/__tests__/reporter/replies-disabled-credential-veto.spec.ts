// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// PR review Finding 2 (High, two-way-replies-client): `config.replies.disabled`
// is documented as a hard local veto — "no polling, no UI, no token presented
// on submit" — but pre-fix it only vetoed the thread client. The adapter still
// created `reporterCredentials` gated solely on `_config.disabled !== true`,
// and both the submit path (provider.tsx reads `adapter.reporterCredentials`)
// and the crash-report outbox drain (adapter.ts's own `reporterCredentials`
// closure var) took credentials from that one seam — so a locally-vetoed
// client still minted/presented a device token, creating server threads it
// could never display.
//
// These specs pin the fix at BOTH ends of that seam:
//   1. the adapter unit level — `reporterCredentials` must be absent when
//      `replies.disabled` is set, even though `disabled` (SDK-wide) is not.
//   2. the crash-outbox-drain integration level — a crash report enqueued and
//      drained by a replies-vetoed adapter must ship with no device-token
//      header and must never touch localStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBreadcrumbBuffer } from '@everframe/sdk-core';
import { createWebPlatformAdapter } from '../../src/adapter.js';
import { scopedReporterTokenStorageKey } from '../../src/reporter/credential-store.js';

const adapters: Array<{ __testCleanup: () => void }> = [];

describe('replies.disabled vetoes the credential seam (Finding 2)', () => {
  afterEach(() => {
    while (adapters.length) adapters.pop()!.__testCleanup();
    localStorage.clear();
  });

  const mk = (config: Parameters<typeof createWebPlatformAdapter>[0]) => {
    const adapter = createWebPlatformAdapter(config);
    adapters.push(adapter);
    return adapter;
  };

  it('does not expose reporterCredentials when replies.disabled is set (SDK-wide enabled)', () => {
    const adapter = mk({ apiKey: 'pk_test', replies: { disabled: true } });
    expect(adapter.reporterCredentials).toBeUndefined();
  });

  it('does not expose the thread client either (pre-existing, still true post-fix)', () => {
    const adapter = mk({ apiKey: 'pk_test', replies: { disabled: true } });
    expect(adapter.threads).toBeUndefined();
  });

  it('still exposes reporterCredentials when replies is left unset (default ON)', () => {
    const adapter = mk({ apiKey: 'pk_test' });
    expect(adapter.reporterCredentials).toBeDefined();
  });

  it('a vetoed adapter does not touch or clear an already-stored token', async () => {
    localStorage.setItem(scopedReporterTokenStorageKey('pk_test'), 'evr_' + 'z'.repeat(43));
    const adapter = mk({ apiKey: 'pk_test', replies: { disabled: true } });
    expect(adapter.reporterCredentials).toBeUndefined();
    // The veto must never delete a pre-existing token — it may be temporary.
    expect(localStorage.getItem(scopedReporterTokenStorageKey('pk_test'))).toBe(
      'evr_' + 'z'.repeat(43),
    );
  });

  describe('crash-outbox drain (the OTHER consumer of the same seam)', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      localStorage.clear();
      fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 'received' }), { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('ships a crash report with no device-token header and mints nothing to localStorage', async () => {
      const adapter = mk({ apiKey: 'pk_test', replies: { disabled: true } });
      const buf = createBreadcrumbBuffer();
      adapter.__setBreadcrumbBuffer(() => buf);

      const err = new Error('veto-path');
      err.stack = 'Error: veto-path\n    at f (a.ts:1:1)';
      window.onerror?.('veto-path', 'a.ts', 1, 1, err);

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | Headers | undefined;
      const tokenHeader =
        headers instanceof Headers ? headers.get('X-Everframe-Device-Token') : headers?.['X-Everframe-Device-Token'];
      expect(tokenHeader).toBeFalsy();
      // No token was ever minted/persisted through the vetoed seam.
      expect(localStorage.getItem(scopedReporterTokenStorageKey('pk_test'))).toBeNull();
    });
  });
});
