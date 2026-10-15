// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, expect, it, vi } from 'vitest';
import Native from '../src/NativeEverframe.js';
import { __setCurrentContext, type EverframeContextValue } from '../src/contextSeam.js';
import { normalizeInteractionPolicy } from '../src/interactions/policy.js';
import { recordLaunchContext } from '../src/interactions/launch.js';
afterEach(() => {
  __setCurrentContext(null);
  vi.restoreAllMocks();
});
it('forwards only explicit trigger and exact allowlisted bounded primitive extras', () => {
  const owner = {};
  __setCurrentContext({
    interactionEvents: {
      policy: normalizeInteractionPolicy({
        launchArgumentKeys: ['campaign', 'count', 'flag', 'url', 'nested'],
      }),
      owner: () => owner,
    },
  } as unknown as EverframeContextValue);
  vi.mocked(Native.recordInteraction).mockClear();
  recordLaunchContext({
    trigger: 'notification',
    arguments: {
      campaign: 'a'.repeat(200),
      count: 2,
      flag: true,
      url: 'https://secret.test/token',
      nested: {} as never,
      secret: 'SECRET',
    },
  });
  const event = JSON.parse(vi.mocked(Native.recordInteraction).mock.calls[0]![3]);
  expect(event).toMatchObject({
    type: 'launch_context',
    trigger: 'notification',
    arguments: { campaign: 'a'.repeat(128), count: 2, flag: true },
  });
  expect(event.arguments.url).toBeUndefined();
  expect(event.arguments.nested).toBeUndefined();
  expect(JSON.stringify(event)).not.toContain('SECRET');
  expect(event.start).toBeUndefined();
});
it('does not execute accessors or send empty/unknown attribution', () => {
  const owner = {};
  __setCurrentContext({
    interactionEvents: { policy: normalizeInteractionPolicy({}), owner: () => owner },
  } as unknown as EverframeContextValue);
  vi.mocked(Native.recordInteraction).mockClear();
  const getter = vi.fn(() => 'notification');
  recordLaunchContext(Object.defineProperty({}, 'trigger', { get: getter }));
  recordLaunchContext({ trigger: 'unknown' as never });
  recordLaunchContext({});
  expect(getter).not.toHaveBeenCalled();
  expect(Native.recordInteraction).not.toHaveBeenCalled();
});
