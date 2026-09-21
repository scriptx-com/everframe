// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// @vitest-environment jsdom
//
// Codex round-3 finding 2 (P1), the WIRING half. `recorder-kill.spec.ts` pins
// what `ReplayRecorder.kill()` does; this pins that `adapter.onKill()` — the
// only thing `client.kill()` and `destroy()` reach — actually calls it.
//
// The recorder the adapter builds is private (no seam, and `config.debug`'s
// diagnostic seam is uninstalled by the same `onKill()` under test), so the
// factory is mocked and the call observed on the double.
import { afterEach, describe, expect, it, vi } from 'vitest';

const recorders: Array<{
  start: ReturnType<typeof vi.fn>;
  freeze: ReturnType<typeof vi.fn>;
  discardAndResume: ReturnType<typeof vi.fn>;
  takeFrozen: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  revive: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('../../../src/capture/replay/index.js', () => ({
  createReplayRecorder: () => {
    const rec = {
      start: vi.fn(),
      freeze: vi.fn(),
      discardAndResume: vi.fn(),
      takeFrozen: vi.fn().mockResolvedValue(null),
      stop: vi.fn(),
      kill: vi.fn(),
      revive: vi.fn(),
      disabled: false,
      __size: 0,
      __diagnostics: vi.fn(),
    };
    recorders.push(rec);
    return rec;
  },
}));

import { createWebPlatformAdapter } from '../../../src/adapter.js';

const adapters: Array<{ __testCleanup: () => void }> = [];

afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  recorders.length = 0;
});

describe('adapter.onKill() shuts the replay recorder down', () => {
  it('LIVE control: a constructed adapter owns a recorder that is not killed', () => {
    const adapter = createWebPlatformAdapter({ apiKey: 'pk_test' });
    adapters.push(adapter);

    expect(recorders).toHaveLength(1);
    expect(recorders[0]!.kill).not.toHaveBeenCalled();
  });

  it('calls kill() on it — not stop(), which the lifecycle can undo', () => {
    const adapter = createWebPlatformAdapter({ apiKey: 'pk_test' });
    adapters.push(adapter);

    adapter.onKill?.();

    expect(recorders[0]!.kill).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second kill() does not throw or double-tear-down', () => {
    const adapter = createWebPlatformAdapter({ apiKey: 'pk_test' });
    adapters.push(adapter);

    adapter.onKill?.();
    adapter.onKill?.();

    expect(recorders[0]!.kill).toHaveBeenCalledTimes(2);
  });

  it('survives a recorder whose kill() throws (DEFE-02)', () => {
    const adapter = createWebPlatformAdapter({ apiKey: 'pk_test' });
    adapters.push(adapter);
    recorders[0]!.kill.mockImplementation(() => {
      throw new Error('rrweb blew up on teardown');
    });

    expect(() => adapter.onKill?.()).not.toThrow();
  });
});
