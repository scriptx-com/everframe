// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, it, vi } from 'vitest';
import { createInteractionTargetRegistration } from '../src/interaction-target-registration.js';

function bridge() {
  return {
    findNodeHandle: vi.fn(() => 12),
    setInteractionTarget: vi.fn(),
    clearInteractionTarget: vi.fn(),
  };
}
it('updates the same host, clears by identity, and never emits breadcrumbs', () => {
  const b = bridge(),
    r = createInteractionTargetRegistration(b, 'A');
  r.update({ name: 'Original', container: { name: 'Originals', index: 0, count: 12 } });
  expect(b.setInteractionTarget).not.toHaveBeenCalled();
  r.attach({});
  r.update({ name: 'Continue', container: { name: 'Continue', index: 1, count: 3 } });
  expect(b.setInteractionTarget).toHaveBeenCalledTimes(2);
  const [first, second] = b.setInteractionTarget.mock.calls;
  expect(second[2]).toBeGreaterThan(first[2]);
  expect(second[3].container).toEqual({ name: 'Continue', index: 1, count: 3 });
  r.update(undefined);
  expect(b.clearInteractionTarget).toHaveBeenLastCalledWith('A', expect.any(Number));
  r.dispose();
});
it('cleanup does not resolve a possibly reused numeric tag and reattachment works', () => {
  const b = bridge(),
    r = createInteractionTargetRegistration(b, 'A');
  r.update({ name: 'Title' });
  r.attach({});
  b.findNodeHandle.mockClear();
  r.attach(null);
  expect(b.findNodeHandle).not.toHaveBeenCalled();
  expect(b.clearInteractionTarget).toHaveBeenCalledTimes(1);
  r.attach({});
  expect(b.setInteractionTarget).toHaveBeenCalledTimes(2);
  r.dispose();
  expect(b.clearInteractionTarget).toHaveBeenCalledTimes(2);
});
it('fails softly for missing, nonfunction, throwing methods and unsupported refs', () => {
  for (const b of [
    undefined,
    {},
    { setInteractionTarget: 7 },
    {
      get setInteractionTarget() {
        throw Error('unavailable');
      },
    },
    {
      findNodeHandle() {
        throw Error('unsupported');
      },
      setInteractionTarget() {
        throw Error('old binary');
      },
      clearInteractionTarget() {
        throw Error('old binary');
      },
    },
  ]) {
    expect(() => {
      const r = createInteractionTargetRegistration(b, 'A');
      r.update({ name: 'Title' });
      r.attach({});
      r.dispose();
    }).not.toThrow();
  }
});
it('drops invalid fields and passes only normalized annotation data', () => {
  const b = bridge(),
    r = createInteractionTargetRegistration(b, 'A');
  r.update({ name: 'x'.repeat(300), screen: 'secret', container: { index: 4, count: 2 } } as never);
  r.attach({});
  expect(b.setInteractionTarget.mock.calls[0][3]).toEqual({ name: 'x'.repeat(256) });
});
