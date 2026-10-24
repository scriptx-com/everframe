// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): the three negotiated config blocks
// (`captureHotkey`, `deviceLinking`, `captureGesture`) and the per-fetch
// `X-Everframe-Capture-Token` header on `GET /api/config`.
import { describe, it, expect, vi } from 'vitest';
import {
  createConfigProvider,
  ReplayConfigResponse,
  CAPTURE_TOKEN_HEADER,
} from '../../src/types/replay/config-provider.js';
import {
  __enableReplayTrace,
  __getReplayTrace,
  __resetReplayTrace,
} from '../../src/debug/replay-trace.js';

const BASE = { replayEnabled: false, replayDurationSec: 30, samplingRate: 1 };
const TOKEN_A = 'evf_dev_' + 'A'.repeat(32);
const TOKEN_B = 'evf_dev_' + 'B'.repeat(32);
const TOKEN_C = 'evf_dev_' + 'C'.repeat(32);

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('device-link config blocks', () => {
  it('parses deviceLinking with a linked user owner and a recording', () => {
    const r = ReplayConfigResponse.safeParse({
      ...BASE,
      captureHotkey: { enabled: true, binding: 'Shift+B', replay: true },
      deviceLinking: {
        enabled: true,
        link: {
          status: 'linked',
          owner: { kind: 'user', name: 'Aurimas' },
          recording: { id: 'r-1', expiresAt: '2026-10-24T10:00:00.000Z' },
        },
      },
      captureGesture: { tv: { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 1500 } },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.captureHotkey).toEqual({ enabled: true, binding: 'Shift+B', replay: true });
    expect(r.data.deviceLinking).toEqual({
      enabled: true,
      link: {
        status: 'linked',
        owner: { kind: 'user', name: 'Aurimas' },
        recording: { id: 'r-1', expiresAt: '2026-10-24T10:00:00.000Z' },
      },
    });
    expect(r.data.captureGesture).toEqual({
      tv: { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 1500 },
    });
  });

  it('a team owner parses, and an unknown nested field is dropped', () => {
    const r = ReplayConfigResponse.safeParse({
      ...BASE,
      deviceLinking: {
        enabled: true,
        future: 1,
        link: { status: 'linked', owner: { kind: 'team' } },
      },
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.deviceLinking).toEqual({
      enabled: true,
      link: { status: 'linked', owner: { kind: 'team' } },
    });
  });

  it('an unknown link status reads as unlinked', () => {
    const r = ReplayConfigResponse.safeParse({
      ...BASE,
      deviceLinking: { enabled: true, link: { status: 'paused' } },
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.deviceLinking?.link?.status).toBe('unlinked');
  });

  it('a malformed owner or recording degrades to absent without dropping the status', () => {
    const r = ReplayConfigResponse.safeParse({
      ...BASE,
      deviceLinking: {
        enabled: true,
        link: { status: 'linked', owner: { kind: 'user' }, recording: { id: 7 } },
      },
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.deviceLinking?.link).toEqual({ status: 'linked' });
  });

  it('a malformed block degrades to absent without failing the parse', () => {
    const r = ReplayConfigResponse.safeParse({
      ...BASE,
      deviceLinking: { enabled: 'yes' },
      captureHotkey: { enabled: true },
      captureGesture: 7,
    });
    expect(r.success).toBe(true);
    expect(
      r.success && [r.data.deviceLinking, r.data.captureHotkey, r.data.captureGesture],
    ).toEqual([undefined, undefined, undefined]);
    expect(r.success && r.data.replayEnabled).toBe(BASE.replayEnabled);
  });
});

describe('capture token on config fetches', () => {
  it('exports the header name', () => {
    expect(CAPTURE_TOKEN_HEADER).toBe('X-Everframe-Capture-Token');
  });

  it('sends X-Everframe-Capture-Token only for a valid evf_dev_ token', async () => {
    const values: Array<() => string | null> = [
      () => 'evf_cap_' + 'x'.repeat(32),
      () => {
        throw new Error('boom');
      },
      () => null,
      () => TOKEN_A + 'x',
      () => TOKEN_A,
    ];
    for (const provider of values) {
      const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => okJson(BASE));
      const cp = createConfigProvider({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        configUrl: 'https://x/api/config',
        sdkKey: 'k',
        captureTokenProvider: provider,
      });
      await cp.refresh();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const headers = headersOf(fetchImpl.mock.calls[0]![1]);
      if (provider === values[4]) {
        expect(headers[CAPTURE_TOKEN_HEADER]).toBe(TOKEN_A);
      } else {
        expect(CAPTURE_TOKEN_HEADER in headers).toBe(false);
      }
    }
  });

  it('sets redirect: error only when the capture token header is attached', async () => {
    let token: string | null = null;
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => okJson(BASE));
    const cp = createConfigProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configUrl: 'https://x/api/config',
      sdkKey: 'k',
      captureTokenProvider: () => token,
    });
    await cp.refresh({ force: true });
    expect(fetchImpl.mock.calls[0]![1]?.redirect).toBeUndefined();
    token = TOKEN_A;
    await cp.refresh({ force: true });
    expect(fetchImpl.mock.calls[1]![1]?.redirect).toBe('error');
  });

  it('reads the provider once per fetch', async () => {
    const provider = vi.fn(() => TOKEN_A);
    const cp = createConfigProvider({
      fetchImpl: (async () => okJson(BASE)) as unknown as typeof fetch,
      configUrl: 'https://x/api/config',
      sdkKey: 'k',
      captureTokenProvider: provider,
    });
    await cp.refresh();
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('committedCaptureToken reports the token the committed response was fetched with', async () => {
    let token: string | null = TOKEN_A;
    type Pending = { resolve: (r: Response) => void };
    const pending: Pending[] = [];
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push({ resolve });
        }),
    );
    const cp = createConfigProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configUrl: 'https://x/api/config',
      sdkKey: 'k',
      captureTokenProvider: () => token,
    });
    expect(cp.committedCaptureToken?.()).toBeNull();

    // #1 with A → 200
    let p = cp.refresh({ force: true });
    pending[0]!.resolve(okJson(BASE));
    await p;
    expect(cp.committedCaptureToken?.()).toBe(TOKEN_A);

    // #2 with B → 500: still A
    token = TOKEN_B;
    p = cp.refresh({ force: true });
    pending[1]!.resolve(new Response('', { status: 500 }));
    await p;
    expect(cp.committedCaptureToken?.()).toBe(TOKEN_A);

    // An older-started request with C, then #3 with B → 200
    token = TOKEN_C;
    const older = cp.refresh({ force: true });
    token = TOKEN_B;
    p = cp.refresh({ force: true });
    pending[3]!.resolve(okJson(BASE));
    await p;
    expect(cp.committedCaptureToken?.()).toBe(TOKEN_B);

    // The older C request resolves after #3 → superseded: still B
    pending[2]!.resolve(okJson(BASE));
    expect(await older).toBe(false);
    expect(cp.committedCaptureToken?.()).toBe(TOKEN_B);

    // A committed fetch without a token reports null.
    token = null;
    p = cp.refresh({ force: true });
    pending[4]!.resolve(okJson(BASE));
    await p;
    expect(cp.committedCaptureToken?.()).toBeNull();
  });

  it('never puts the token in the replay trace', async () => {
    __resetReplayTrace();
    __enableReplayTrace(true);
    try {
      const cp = createConfigProvider({
        fetchImpl: (async () => okJson(BASE)) as unknown as typeof fetch,
        configUrl: 'https://x/api/config',
        sdkKey: 'k',
        captureTokenProvider: () => TOKEN_A,
      });
      await cp.refresh();
      const trace = JSON.stringify(__getReplayTrace());
      expect(trace).not.toContain('evf_dev_');
      expect(trace).toContain('carriedToken');
    } finally {
      __enableReplayTrace(false);
      __resetReplayTrace();
    }
  });
});
