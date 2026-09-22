// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { createFakePlatformAdapter } from '../src/__test-helpers__/fake-platform-adapter.js';
import type { CaptureExceptionOptions } from '../src/index.js';

afterEach(() => vi.restoreAllMocks());

describe('captureException facade', () => {
  it('forwards the original caught value and options only while reporting is enabled', () => {
    const captured: Array<{ error: unknown; options: CaptureExceptionOptions | undefined }> = [];
    const client = createClient({
      ...createFakePlatformAdapter(),
      captureException: (error, options) => { captured.push({ error, options }); },
    });
    const error = new Error('checkout failed');
    const options = { severity: 'warning', context: 'checkout', metadata: { retry: 2 } } as const;
    client.captureException(error, options);
    expect(captured).toEqual([]);
    client.init({ apiKey: 'test', disabled: true });
    client.captureException(error, options);
    expect(captured).toEqual([]);
    client.init({ apiKey: 'test', crashReporting: { disabled: true } });
    client.captureException(error, options);
    expect(captured).toEqual([]);
    client.init({ apiKey: 'test' });
    client.captureException(error, options);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ error, options });
    expect(captured[0]!.error).toBe(error);
    expect(captured[0]!.options).toBe(options);
    client.kill();
    client.captureException(error, options);
    expect(captured).toHaveLength(1);
  });

  it('allows adapters that do not implement exception reporting', () => {
    const client = createClient(createFakePlatformAdapter());
    client.init({ apiKey: 'test' });
    expect(() => client.captureException(new Error('caught'), { context: 'checkout' })).not.toThrow();
  });

  it('contains adapter failures even when the host error callback also throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onError = vi.fn(() => { throw new Error('host callback failed'); });
    const client = createClient({
      ...createFakePlatformAdapter(),
      captureException() { throw new Error('adapter failed'); },
    });
    client.init({ apiKey: 'test', onError });
    expect(() => client.captureException(new Error('caught'))).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'adapter failed' }));
  });
});
