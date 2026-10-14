// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, expect, it, vi } from 'vitest';
import Native from '../src/NativeEverframe.js';
import { __setCurrentContext, type EverframeContextValue } from '../src/contextSeam.js';
import { normalizeInteractionPolicy } from '../src/interactions/policy.js';
import { observePermissionRequest } from '../src/interactions/permissions.js';
function mount() {
  const owner = {};
  __setCurrentContext({
    interactionEvents: { policy: normalizeInteractionPolicy({}), owner: () => owner },
  } as unknown as EverframeContextValue);
  vi.mocked(Native.getInteractionLease).mockReturnValue('A');
  vi.mocked(Native.recordInteraction).mockClear();
}
afterEach(() => {
  __setCurrentContext(null);
  vi.restoreAllMocks();
});
const events = () => vi.mocked(Native.recordInteraction).mock.calls.map((c) => JSON.parse(c[3]));
it('invokes the operation exactly once and returns its exact object', async () => {
  mount();
  const result = { status: 'limited' };
  const operation = vi.fn(async () => result);
  expect(await observePermissionRequest('photos', operation, (r) => r.status as 'limited')).toBe(
    result,
  );
  expect(operation).toHaveBeenCalledTimes(1);
  expect(events()).toMatchObject([
    { type: 'permission', phase: 'requested' },
    { phase: 'result', result: 'limited' },
  ]);
});
it('preserves synchronous throws and rejected identities without claiming denial', async () => {
  mount();
  const error = {};
  const mapper = vi.fn();
  await expect(
    observePermissionRequest(
      'camera',
      () => {
        throw error;
      },
      mapper,
    ),
  ).rejects.toBe(error);
  await expect(
    observePermissionRequest('camera', () => Promise.reject(error), mapper),
  ).rejects.toBe(error);
  expect(mapper).not.toHaveBeenCalled();
  expect(
    events()
      .filter((e) => e.phase === 'result')
      .map((e) => e.result),
  ).toEqual(['unknown', 'unknown']);
});
it('mapper exceptions preserve the result and Android strings normalize explicitly', async () => {
  mount();
  expect(
    await observePermissionRequest(
      'camera',
      async () => 'granted',
      () => {
        throw Error();
      },
    ),
  ).toBe('granted');
  expect(events().at(-1).result).toBe('unknown');
  for (const [input, result] of [
    ['granted', 'granted'],
    ['denied', 'denied'],
    ['never_ask_again', 'blocked'],
    ['maybe', 'unknown'],
  ]) {
    await observePermissionRequest('camera', async () => input);
    expect(events().at(-1).result).toBe(result);
  }
});
it('revocation drops late results and never stops the operation', async () => {
  mount();
  let resolve!: (v: object) => void;
  const result = {};
  const pending = observePermissionRequest(
    'camera',
    () =>
      new Promise<object>((r) => {
        resolve = r;
      }),
    () => 'granted',
  );
  vi.mocked(Native.getInteractionLease).mockReturnValue('B');
  resolve(result);
  expect(await pending).toBe(result);
  expect(events()).toHaveLength(1);
});
it('no provider, old binary and web preserve app behavior', async () => {
  const operation = vi.fn(async () => 42);
  expect(await observePermissionRequest('camera', operation)).toBe(42);
  mount();
  vi.mocked(Native.getInteractionLease).mockImplementation(() => {
    throw Error();
  });
  expect(await observePermissionRequest('camera', operation)).toBe(42);
  const web = await import('../src/index.web.js');
  expect(await web.observePermissionRequest('camera', operation)).toBe(42);
  expect(operation).toHaveBeenCalledTimes(3);
  expect(events()).toHaveLength(0);
});
