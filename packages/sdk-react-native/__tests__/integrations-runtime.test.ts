// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Integration orchestration (spec 2026-07-14 RN-iOS parity): opt-in
// integrations are set up at the end of runtime.mount() (context is already
// published, so setups may call top-level seam functions) and torn down at
// unmount() after capture ownership and context are invalidated. A throwing setup must never
// break mount.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../src/runtime.js';
import { __getCurrentContext, __setCurrentContext } from '../src/contextSeam.js';

describe('runtime integrations', () => {
  afterEach(() => {
    __setCurrentContext(null);
    vi.restoreAllMocks();
  });

  it('runs setup on mount (after context publish) and teardown on unmount (after context clear)', () => {
    let teardownContext: unknown = 'not called';
    const teardown = vi.fn(() => { teardownContext = __getCurrentContext(); });
    const setup = vi.fn(() => {
      expect(__getCurrentContext()).not.toBeNull();
      return teardown;
    });
    const rt = createRuntime({ apiKey: 'k', integrations: [{ name: 'fake', setup }] });
    rt.mount();
    expect(setup).toHaveBeenCalledTimes(1);
    rt.unmount();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(teardownContext).toBeNull();
  });

  it('a throwing setup warns and does not break mount or other integrations', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = vi.fn();
    const rt = createRuntime({
      apiKey: 'k',
      integrations: [
        { name: 'boom', setup: () => { throw new Error('nope'); } },
        { name: 'good', setup: good },
      ],
    });
    rt.mount();
    expect(good).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("integration 'boom' setup threw"));
    rt.unmount();
  });

  it('a throwing teardown warns and does not break unmount', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = createRuntime({
      apiKey: 'k',
      integrations: [{ name: 'boom', setup: () => () => { throw new Error('nope'); } }],
    });
    rt.mount();
    expect(() => rt.unmount()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("integration 'boom' teardown threw"));
  });

  it('setup-less mount/unmount stays a no-op (no integrations field)', () => {
    const rt = createRuntime({ apiKey: 'k' });
    rt.mount();
    rt.unmount();
  });
});
