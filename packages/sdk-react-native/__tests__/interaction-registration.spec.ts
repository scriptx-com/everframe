// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, it, vi } from 'vitest';
import { createInteractionRegistration } from '../src/interactions/registration.js';
import { normalizeInteractionPolicy } from '../src/interactions/policy.js';

function fixture(allowed = false) {
  let lease = 'lease-1';
  let owner: object | undefined = {};
  const bridge = {
    findNodeHandle: vi.fn(() => 12),
    getInteractionLease: vi.fn(() => lease),
    setInteractionObserver: vi.fn(
      (_tag: number, _id: string, _generation: number, _lease: string, _json: string) => true,
    ),
    clearInteractionObserver: vi.fn((_id: string, _generation: number) => true),
    recordInteraction: vi.fn(
      (_lease: string, _id: string, _generation: number, _json: string) => true,
    ),
  };
  const scope = {
    policy: normalizeInteractionPolicy({ valueTestIds: allowed ? ['search'] : [] }),
    owner: () => owner,
  };
  const registration = createInteractionRegistration(bridge, scope, 'A', {
    target: { testId: 'search' },
    helperTypes: ['text_edit', 'control_change', 'scroll'],
  });
  return {
    bridge,
    scope,
    registration,
    revoke: () => {
      lease = 'lease-2';
    },
    unmount: () => {
      owner = undefined;
    },
    remount: () => {
      owner = {};
    },
  };
}
it('keeps automatic text ownership and never forwards unverifiable JS text metadata', () => {
  const f = fixture(true);
  f.registration.attach({});
  expect(JSON.parse(f.bridge.setInteractionObserver.mock.calls[0][4])).toEqual({
    target: { testId: 'search' },
    helperTypes: ['control_change', 'scroll'],
  });
  f.registration.textChanged('SECRET', { reason: 'end' });
  f.registration.textChanged('SECRET', {
    get composing(): boolean {
      throw Error('must not inspect unsupported text input');
    },
  });
  expect(f.bridge.recordInteraction).not.toHaveBeenCalled();
  f.registration.controlChanged({ control: 'checkbox', checked: true });
  expect(JSON.parse(f.bridge.recordInteraction.mock.calls[0][3])).toMatchObject({
    type: 'control_change',
    control: 'checkbox',
    checked: true,
  });
  const textOnly = createInteractionRegistration(f.bridge, f.scope, 'B', {
    target: { name: 'Search' },
    helperTypes: ['text_edit'],
  });
  textOnly.attach({});
  expect(JSON.parse(f.bridge.setInteractionObserver.mock.calls.at(-1)![4])).toEqual({
    target: { name: 'Search' },
    helperTypes: [],
  });
});
it('acquires ownership only on committed attachment and preserves the captured lease', () => {
  const f = fixture();
  expect(f.bridge.getInteractionLease).not.toHaveBeenCalled();
  f.registration.controlChanged({ control: 'checkbox', checked: false });
  expect(f.bridge.recordInteraction).not.toHaveBeenCalled();
  f.registration.attach({});
  f.registration.controlChanged({ control: 'checkbox', checked: true });
  const call = f.bridge.recordInteraction.mock.calls.at(-1)!;
  expect(call.slice(0, 2)).toEqual(['lease-1', 'A']);
  expect(JSON.parse(call[3])).toMatchObject({
    checked: true,
    control: 'checkbox',
    type: 'control_change',
  });
  f.revoke();
  f.registration.controlChanged({ control: 'checkbox', checked: false });
  f.registration.start();
  expect(f.bridge.recordInteraction).toHaveBeenCalledTimes(1);
  expect(f.bridge.setInteractionObserver).toHaveBeenCalledTimes(1);
  f.registration.attach({});
  f.registration.controlChanged({ control: 'checkbox', checked: false });
  expect(f.bridge.recordInteraction.mock.calls.at(-1)![0]).toBe('lease-2');
});
it('control values require an exact local ID and are bounded in UTF16', () => {
  const f = fixture(true);
  f.registration.attach({});
  f.registration.controlChanged({ control: 'picker', optionId: 'safe', value: '😀'.repeat(200) });
  expect(JSON.parse(f.bridge.recordInteraction.mock.calls.at(-1)![3]).value).toBe('😀'.repeat(128));
  const denied = fixture();
  denied.registration.attach({});
  denied.registration.controlChanged({ control: 'picker', optionId: 'safe', value: 'SECRET' });
  expect(denied.bridge.recordInteraction.mock.calls.at(-1)![3]).not.toContain('SECRET');
});
it('unmount and a new mount identity never renew an old callback', () => {
  const f = fixture();
  f.registration.attach({});
  const callback = f.registration.controlChanged;
  f.unmount();
  callback({ control: 'checkbox', checked: true });
  f.remount();
  callback({ control: 'checkbox', checked: false });
  expect(f.bridge.recordInteraction).not.toHaveBeenCalled();
  f.registration.dispose();
  expect(f.bridge.clearInteractionObserver).toHaveBeenCalledTimes(1);
});
it('missing/throwing bridges and failed native attachment leave automatic capture available', () => {
  for (const bridge of [
    undefined,
    {},
    Object.defineProperty({}, 'getInteractionLease', {
      get() {
        throw Error('getter');
      },
    }),
  ]) {
    const f = fixture();
    const r = createInteractionRegistration(bridge, f.scope, 'A', {
      helperTypes: ['control_change'],
    });
    expect(() => {
      r.attach({});
      r.controlChanged({ control: 'checkbox', checked: true });
      r.dispose();
    }).not.toThrow();
  }
  const f = fixture();
  f.bridge.setInteractionObserver.mockReturnValue(false);
  f.registration.attach({});
  f.registration.controlChanged({ control: 'checkbox', checked: true });
  expect(f.bridge.recordInteraction).not.toHaveBeenCalled();
});
it('only selected helper types can submit and hostile optional values never escape', () => {
  const f = fixture();
  const r = createInteractionRegistration(f.bridge, f.scope, 'A', { helperTypes: ['scroll'] });
  r.attach({});
  r.textChanged('SECRET');
  r.controlChanged({ control: 'switch', checked: true });
  expect(f.bridge.recordInteraction).not.toHaveBeenCalled();
  r.scrollSettled({ axis: 'y', direction: 'forward' });
  expect(JSON.parse(f.bridge.recordInteraction.mock.calls[0][3])).toMatchObject({
    type: 'scroll',
    axis: 'y',
    direction: 'forward',
  });
  expect(() =>
    r.scrollSettled(
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw Error('no');
          },
        },
      ) as never,
    ),
  ).not.toThrow();
  expect(f.bridge.recordInteraction).toHaveBeenCalledTimes(1);
});
it('updates create distinct generations, and an old disposal cannot clear a newer registration', () => {
  const f = fixture();
  f.registration.attach({});
  const first = f.bridge.setInteractionObserver.mock.calls[0];
  f.registration.dispose();
  const next = createInteractionRegistration(f.bridge, f.scope, 'A', {
    helperTypes: ['control_change'],
  });
  next.attach({});
  const last = f.bridge.setInteractionObserver.mock.calls.at(-1)!;
  expect(last[2]).toBeGreaterThan(first[2]);
  f.bridge.clearInteractionObserver.mockClear();
  f.registration.dispose();
  expect(f.bridge.clearInteractionObserver).not.toHaveBeenCalled();
});
it('normalizing malformed metadata never turns its testId into a value permission', () => {
  const f = fixture(true);
  const longest = `search${'x'.repeat(250)}`;
  f.scope.policy.valueTestIds.push(longest);
  for (const testId of ['search\0', `${longest}x`]) {
    const r = createInteractionRegistration(f.bridge, f.scope, 'A', {
      target: { testId },
      helperTypes: ['control_change'],
    });
    r.attach({});
    r.controlChanged({ control: 'picker', optionId: 'safe', value: 'SECRET' });
    r.dispose();
  }
  expect(f.bridge.recordInteraction.mock.calls).toHaveLength(2);
  for (const call of f.bridge.recordInteraction.mock.calls) expect(call[3]).not.toContain('SECRET');
});
