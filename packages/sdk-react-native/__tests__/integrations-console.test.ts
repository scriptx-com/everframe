// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// consoleIntegration (spec 2026-07-14 RN-iOS parity): wraps console
// methods, ALWAYS calls the original first, forwards to the native crumb
// buffer with real severity, guards re-entrancy (the Android stderr-tee
// recursion of 2026-07-14 is the failure mode this prevents), and restores
// on teardown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleIntegration } from '../src/integrations/console.js';
import { __setCurrentContext } from '../src/contextSeam.js';

describe('consoleIntegration', () => {
  const crumbs = vi.fn();
  let teardown: (() => void) | void;

  beforeEach(() => {
    crumbs.mockReset();
    __setCurrentContext({ addBreadcrumb: crumbs } as never);
  });

  afterEach(() => {
    if (teardown) teardown();
    teardown = undefined;
    __setCurrentContext(null);
  });

  it('forwards console.warn with level warn, original still called', () => {
    const original = vi.spyOn(console, 'warn').mockImplementation(() => {});
    teardown = consoleIntegration().setup();
    console.warn('disk low', { free: 12 });
    expect(original).toHaveBeenCalledWith('disk low', { free: 12 });
    expect(crumbs).toHaveBeenCalledWith({
      message: 'disk low {"free":12}',
      kind: 'console',
      level: 'warn',
    });
  });

  it('maps console.log to level info', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    teardown = consoleIntegration().setup();
    console.log('hello');
    expect(crumbs).toHaveBeenCalledWith({ message: 'hello', kind: 'console', level: 'info' });
  });

  it('respects the levels option', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    teardown = consoleIntegration({ levels: ['error'] }).setup();
    console.log('not captured');
    console.error('captured');
    expect(crumbs).toHaveBeenCalledTimes(1);
    expect(crumbs).toHaveBeenCalledWith({ message: 'captured', kind: 'console', level: 'error' });
  });

  it('re-entrancy: a crumb sink that logs cannot loop', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    crumbs.mockImplementation(() => {
      console.log('sink logging back');   // must NOT recurse into a new crumb
    });
    teardown = consoleIntegration().setup();
    console.log('outer');
    expect(crumbs).toHaveBeenCalledTimes(1);
  });

  it("skips the SDK's own '[everframe]' lines", () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    teardown = consoleIntegration().setup();
    console.warn('[everframe] configure threw: x');
    expect(crumbs).not.toHaveBeenCalled();
  });

  it('teardown restores the original methods', () => {
    const before = console.info;
    teardown = consoleIntegration({ levels: ['info'] }).setup();
    expect(console.info).not.toBe(before);
    if (teardown) teardown();
    teardown = undefined;
    expect(console.info).toBe(before);
  });

  it('deduped levels: teardown restores the pristine original, not a wrapper', () => {
    const before = console.info;
    teardown = consoleIntegration({ levels: ['info', 'info'] }).setup();
    console.info('one crumb please');
    expect(crumbs).toHaveBeenCalledTimes(1);
    if (teardown) teardown();
    teardown = undefined;
    expect(console.info).toBe(before);
  });

  it('serializes Errors and circular objects without throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    teardown = consoleIntegration().setup();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    console.error(new Error('boom'), circular);
    expect(crumbs).toHaveBeenCalledTimes(1);
    const message = (crumbs.mock.calls[0]![0] as { message: string }).message;
    expect(message).toContain('boom');
  });
});
