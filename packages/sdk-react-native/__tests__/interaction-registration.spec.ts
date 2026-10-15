// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, it, vi } from 'vitest';
import {
  createInteractionRegistration,
  normalizeInteractionOptions,
} from '../src/interactions/registration.js';
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
it('leaves automatic native ownership active for every legacy helper declaration', () => {
  const f = fixture(true);
  f.registration.attach({});
  expect(JSON.parse(f.bridge.setInteractionObserver.mock.calls[0][4])).toEqual({
    target: { testId: 'search' },
    helperTypes: [],
  });
  for (const helperTypes of [
    ['text_edit'],
    ['control_change'],
    ['scroll'],
    ['scroll', 'text_edit', 'control_change'],
  ]) {
    expect(normalizeInteractionOptions({ target: { name: 'Search' }, helperTypes })).toEqual({
      target: { name: 'Search' },
      helperTypes: [],
    });
  }
});
it('never inspects or forwards JS helper payloads even on an allowlisted attached host', () => {
  const f = fixture(true);
  f.registration.attach({});
  const read = vi.fn(() => {
    throw Error('private input must not be inspected');
  });
  const hostile = new Proxy({}, { get: read, getOwnPropertyDescriptor: read, ownKeys: read });
  expect(() => {
    f.registration.textChanged(hostile as never, hostile);
    f.registration.controlChanged(hostile as never);
    f.registration.scrollSettled(hostile as never);
    f.registration.controlChanged({ control: 'checkbox', checked: true });
    f.registration.controlChanged({ control: 'picker', optionId: 'safe', value: 'SECRET' });
    f.registration.scrollSettled({ axis: 'y', direction: 'forward' });
  }).not.toThrow();
  expect(read).not.toHaveBeenCalled();
  expect(f.bridge.recordInteraction).not.toHaveBeenCalled();
});
it('acquires metadata ownership only on committed attachment and never renews a revoked lease', () => {
  const f = fixture();
  expect(f.bridge.getInteractionLease).not.toHaveBeenCalled();
  f.registration.start();
  expect(f.bridge.setInteractionObserver).not.toHaveBeenCalled();
  f.registration.attach({});
  expect(f.bridge.setInteractionObserver.mock.calls[0].slice(0, 2)).toEqual([12, 'A']);
  expect(f.bridge.setInteractionObserver.mock.calls[0][3]).toBe('lease-1');
  f.revoke();
  f.registration.start();
  expect(f.bridge.setInteractionObserver).toHaveBeenCalledTimes(1);
  f.registration.attach({});
  expect(f.bridge.clearInteractionObserver).toHaveBeenCalledTimes(1);
  expect(f.bridge.setInteractionObserver.mock.calls.at(-1)![3]).toBe('lease-2');
  expect(JSON.parse(f.bridge.setInteractionObserver.mock.calls.at(-1)![4]).helperTypes).toEqual([]);
});
it('provider identity changes never replay committed metadata, and disposal clears the original owner', () => {
  const f = fixture();
  f.registration.attach({});
  const first = f.bridge.setInteractionObserver.mock.calls[0];
  f.unmount();
  f.registration.start();
  f.remount();
  f.registration.start();
  expect(f.bridge.setInteractionObserver).toHaveBeenCalledTimes(1);
  f.registration.dispose();
  expect(f.bridge.clearInteractionObserver).toHaveBeenCalledTimes(1);
  expect(f.bridge.clearInteractionObserver.mock.calls[0][0]).toBe(first[1]);
  expect(f.bridge.clearInteractionObserver.mock.calls[0][1]).toBeGreaterThan(first[2]);
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
it('validates legacy helper lists without evaluating accessors or dropping valid target metadata', () => {
  const read = vi.fn(() => {
    throw Error('host accessor');
  });
  const accessor = Object.defineProperty(['control_change'], '0', { get: read });
  expect(
    normalizeInteractionOptions({ target: { name: 'Search' }, helperTypes: accessor }),
  ).toEqual({ helperTypes: [] });
  expect(read).not.toHaveBeenCalled();
  for (const helperTypes of [
    ['unknown'],
    ['text_edit', 'scroll', 'control_change', 'scroll'],
    undefined,
  ]) {
    expect(normalizeInteractionOptions({ target: { name: 'Search' }, helperTypes })).toEqual({
      target: { name: 'Search' },
      helperTypes: [],
    });
  }
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
  expect(f.bridge.recordInteraction).not.toHaveBeenCalled();
  for (const call of f.bridge.setInteractionObserver.mock.calls) {
    expect(JSON.parse(call[4]).target?.testId).toBeUndefined();
    expect(JSON.parse(call[4]).helperTypes).toEqual([]);
  }
});

it('registers target metadata on a bridge without JS helper submission support', () => {
  const f = fixture();
  const { recordInteraction: _record, ...bridge } = f.bridge;
  const r = createInteractionRegistration(bridge, f.scope, 'metadata', {
    target: { name: 'Native search' },
    helperTypes: ['control_change'],
  });
  r.attach({});
  expect(bridge.setInteractionObserver).toHaveBeenCalledTimes(1);
  expect(JSON.parse(bridge.setInteractionObserver.mock.calls[0][4])).toEqual({
    target: { name: 'Native search' },
    helperTypes: [],
  });
  r.dispose();
  expect(bridge.clearInteractionObserver).toHaveBeenCalledTimes(1);
});
