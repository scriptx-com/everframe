// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { createPlayerRegistry } from '../../src/vitals/registry.js';

describe('createPlayerRegistry', () => {
  it('mints stable ids per element in first-seen order, weakly (no registration needed)', () => {
    const r = createPlayerRegistry();
    const a = document.createElement('video'), b = document.createElement('audio');
    expect(r.idFor(a)).toBe('p1');
    expect(r.idFor(b)).toBe('p2');
    expect(r.idFor(a)).toBe('p1');
    expect(r.registered()).toEqual([]);
  });
  // Codex round-2 item 6 — this test used to assert `register()` REPLACES
  // the whole record, so a second call with no `name` erased a first call's
  // `name`. That was itself the defect: the LIVE adapter's `upgrade()` only
  // ever merges the fields a repeat `trackPlayer()` call actually supplies,
  // so a collector restart (which rebuilds every player from
  // `registered()`) disagreed with the still-running live player about the
  // same registration's name/integration. `register()` now merges the same
  // way — a supplied field overrides, an omitted one is kept.
  it('register() returns the same id idFor() would, merges a second registration\'s supplied fields, and unregister() removes it', () => {
    const r = createPlayerRegistry();
    const a = document.createElement('video');
    expect(r.idFor(a)).toBe('p1');
    expect(r.register({ element: a, name: 'main' })).toBe('p1');
    const integ = { library: 'x', attach() {}, detach() {} };
    r.register({ element: a, integration: integ });
    // The second call omitted `name` — it must survive the merge, not be
    // erased the way a full replace would.
    expect(r.registered()).toEqual([{ element: a, name: 'main', integration: integ }]);
    r.unregister(a);
    expect(r.registered()).toEqual([]);
    expect(r.idFor(a)).toBe('p1'); // identity survives unregister
  });
  // Codex round-2 item 6 — the merge must still let a later call OVERRIDE a
  // field it explicitly supplies; only OMITTED fields are preserved.
  it('a supplied field overrides the previous registration\'s value for that field', () => {
    const r = createPlayerRegistry();
    const a = document.createElement('video');
    r.register({ element: a, name: 'first' });
    r.register({ element: a, name: 'second' });
    expect(r.registered()).toEqual([{ element: a, name: 'second' }]);
  });
  // Codex round-2 item 6 — a bare second registration (no name, no
  // integration at all) must not erase either field from the first.
  it('a second bare registration does not erase a name or integration', () => {
    const r = createPlayerRegistry();
    const a = document.createElement('video');
    const integ = { library: 'hls.js', attach() {}, detach() {} };
    r.register({ element: a, name: 'main', integration: integ });
    r.register({ element: a });
    expect(r.registered()).toEqual([{ element: a, name: 'main', integration: integ }]);
  });
  it('clear() drops registrations but keeps the id counter monotonic', () => {
    const r = createPlayerRegistry();
    r.register({ element: document.createElement('video') });
    r.clear();
    expect(r.registered()).toEqual([]);
    expect(r.idFor(document.createElement('video'))).toBe('p2');
  });
});
