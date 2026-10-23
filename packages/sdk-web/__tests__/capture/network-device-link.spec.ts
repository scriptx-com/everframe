// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture: the device token and link nonce must never land
// in captured network evidence, even with body capture on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  filterHeaders,
  installFetchPatcher,
  installXHRPatcher,
  unpatchedFetch,
  type BodyCaptureHooks,
} from '../../src/capture/network.js';
import { getNetworkSnapshot, networkBuffer } from '../../src/capture/buffers.js';
import { INGEST_URL } from '../../src/constants.js';
import type { NetworkBodyEntry } from '@everframe/protocol';

const TOKEN = 'evf_dev_' + 'T'.repeat(32);
const NONCE = 'n'.repeat(40);
const INGEST = INGEST_URL.replace(/\/$/, '');
const CHECK_URL = `${INGEST}/api/device-link/attempts/0b7c2c3e-8f2a-4c1d-9e1b-3f6a5d4c2b1a/check`;

function hooks(): { h: BodyCaptureHooks; sunk: NetworkBodyEntry[] } {
  const sunk: NetworkBodyEntry[] = [];
  let id = 0;
  return {
    sunk,
    h: {
      enabled: () => true,
      config: () => ({ bodyByteCap: 8192, bodyContentTypes: ['application/json', 'text/*'] }),
      redaction: () => ({}),
      nextReqId: () => ++id,
      sink: (e) => sunk.push(e),
    },
  };
}

beforeEach(() => {
  networkBuffer.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('device-link secrets stay out of captured network evidence', () => {
  it('capture and link-nonce request headers are redacted', () => {
    expect(
      filterHeaders({ 'X-Everframe-Capture-Token': TOKEN, 'X-Everframe-Link-Nonce': NONCE }),
    ).toEqual({
      'X-Everframe-Capture-Token': '[REDACTED]',
      'X-Everframe-Link-Nonce': '[REDACTED]',
    });
    expect(filterHeaders({ 'x-everframe-device-token': 'secret' })).toEqual({
      'x-everframe-device-token': '[REDACTED]',
    });
    const h = new Headers({ 'X-Everframe-Capture-Token': TOKEN });
    expect(JSON.stringify(filterHeaders(h))).not.toContain(TOKEN);
  });

  it('no body is captured for device-link endpoints even with body capture on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ status: 'linked', token: TOKEN, owner: { kind: 'team' } }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
      ),
    );
    const { h, sunk } = hooks();
    const crumbSink = vi.fn();
    const uninstall = installFetchPatcher({ bodyCapture: h, crumbSink });
    try {
      const res = await fetch(CHECK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Everframe-Link-Nonce': NONCE },
        body: JSON.stringify({ attemptNonce: NONCE }),
      });
      expect((await res.json()).token).toBe(TOKEN); // the caller still reads its body
      await new Promise((r) => setTimeout(r, 20));
      expect(sunk).toHaveLength(0);
      const entries = getNetworkSnapshot();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ method: 'POST', url: CHECK_URL, status: 200 });
      expect(entries[0]!.headers).toBeUndefined();
      expect(JSON.stringify(entries)).not.toContain(TOKEN);
      expect(JSON.stringify(entries)).not.toContain(NONCE);
      expect(JSON.stringify(crumbSink.mock.calls)).not.toContain(TOKEN);
    } finally {
      uninstall();
    }
  });

  it('other URLs on the same origin still get body capture', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const { h, sunk } = hooks();
    const uninstall = installFetchPatcher({ bodyCapture: h });
    try {
      await fetch(`${INGEST}/api/somewhere-else`);
      await vi.waitFor(() => expect(sunk).toHaveLength(1));
    } finally {
      uninstall();
    }
  });

  it('the XHR patcher skips device-link bodies too', () => {
    class FakeXHR {
      status = 200;
      readyState = 0;
      responseType: XMLHttpRequestResponseType = '';
      responseText = '';
      private listeners: Array<() => void> = [];
      open(_m: string, _u: string) {}
      setRequestHeader(_k: string, _v: string) {}
      getResponseHeader() {
        return 'application/json';
      }
      addEventListener(_t: string, cb: () => void) {
        this.listeners.push(cb);
      }
      removeEventListener() {}
      send(_b?: unknown) {
        this.readyState = 4;
        this.responseText = JSON.stringify({ status: 'linked', token: TOKEN });
        for (const cb of this.listeners) cb();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    const { h, sunk } = hooks();
    const crumbSink = vi.fn();
    const uninstall = installXHRPatcher({ bodyCapture: h, crumbSink });
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', CHECK_URL);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ attemptNonce: NONCE }));
      expect(sunk).toHaveLength(0);
      expect(getNetworkSnapshot()).toHaveLength(1);
      expect(JSON.stringify(getNetworkSnapshot())).not.toContain(TOKEN);
      expect(crumbSink).toHaveBeenCalledTimes(1);
      // Control: another URL is captured.
      const other = new XMLHttpRequest();
      other.open('POST', `${INGEST}/api/other`);
      other.setRequestHeader('Content-Type', 'application/json');
      other.send('{}');
      expect(sunk).toHaveLength(1);
    } finally {
      uninstall();
    }
  });

  it('unpatchedFetch returns the fetch the patcher wrapped', async () => {
    const original = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', original);
    const uninstall = installFetchPatcher({});
    try {
      expect(globalThis.fetch).not.toBe(original);
      const f = unpatchedFetch();
      expect(f).not.toBeNull();
      await f!('https://x.test/a');
      expect(original).toHaveBeenCalledTimes(1);
      expect(getNetworkSnapshot()).toHaveLength(0);
    } finally {
      uninstall();
    }
  });

  it('unpatchedFetch falls back to the global fetch, else null', async () => {
    const plain = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', plain);
    await unpatchedFetch()!('https://x.test/b');
    expect(plain).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', undefined);
    expect(unpatchedFetch()).toBeNull();
  });
});
