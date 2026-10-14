// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeInteractionPolicy } from '../src/interactions/policy.js';
import { sanitizeInteractionUrl } from '../src/interactions/links.js';
const policy = normalizeInteractionPolicy({
  urlRules: [
    {
      origin: 'https://example.test',
      routes: ['/watch/:id'],
      literalPaths: ['/help'],
      queryKeys: ['campaign', 'q'],
    },
    { origin: 'nocturne://watch', routes: ['/:id'] },
  ],
});
afterEach(() => vi.restoreAllMocks());
it('defaults to structural evidence and never copies credentials, fragments or unknown paths', () => {
  expect(
    sanitizeInteractionUrl(
      'https://user:password@example.test/secret-token?token=SECRET#SECRET',
      normalizeInteractionPolicy({}),
    ),
  ).toBe('https://example.test');
  expect(sanitizeInteractionUrl('https://example.test/unknown/SECRET?q=ok', policy)).toBe(
    'https://example.test?q=ok',
  );
  expect(sanitizeInteractionUrl('https://other.test/watch/SECRET?campaign=SECRET', policy)).toBe(
    'https://other.test',
  );
});
it('uses declared templates and scoped query keys, deduplicates keys and redacts', () => {
  expect(
    sanitizeInteractionUrl(
      'https://example.test/watch/SECRET?campaign=one&campaign=two&token=SECRET&q=4111111111111111',
      policy,
    ),
  ).toBe('https://example.test/watch/:id?campaign=one&q=%5BREDACTED%3ACC%5D');
  expect(sanitizeInteractionUrl('nocturne://watch/SECRET', policy)).toBe('nocturne://watch/:id');
  expect(sanitizeInteractionUrl('https://example.test/help', policy)).toBe(
    'https://example.test/help',
  );
});
it.each([
  '/watch/a%2Fb',
  '/watch/a%5cb',
  '/watch/%2e%2e',
  '/watch/../help',
  '/watch/%252f',
  '/watch/%ZZ',
  '/watch/%C0%AF',
  '/watch/x#%ZZ',
])('rejects ambiguous or malformed path %s', (path) => {
  expect(sanitizeInteractionUrl('https://example.test' + path, policy)).toBeUndefined();
});
it('bounds raw input and query strings without splitting a surrogate pair', () => {
  expect(
    sanitizeInteractionUrl('https://example.test/' + 'a'.repeat(8192), policy),
  ).toBeUndefined();
  expect(
    sanitizeInteractionUrl(
      'https://example.test/watch/SECRET?q=' + encodeURIComponent('😀'.repeat(200)),
      policy,
    )?.length,
  ).toBeLessThanOrEqual(1024);
  expect(sanitizeInteractionUrl('https://example.test/help?q=%ZZ', policy)).toBeUndefined();
});
it('owns one subscription, asks initial URL once, and admits distinct later openings of the same URL', async () => {
  vi.resetModules();
  const { installInteractionLinks } = await import('../src/interactions/links.js');
  let listener!: (event: { url: string }) => void;
  let resolve!: (url: string) => void;
  const linking = {
    addEventListener: vi.fn((_type: string, fn: typeof listener) => {
      listener = fn;
      return { remove: vi.fn() };
    }),
    getInitialURL: vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    ),
  };
  let owner: object | undefined = {};
  let lease = 'A';
  const send = vi.fn();
  const runtime = { interactionEvents: { policy, owner: () => owner } };
  const bridge = { getInteractionLease: () => lease, recordInteraction: send };
  const stop = installInteractionLinks(runtime, linking, bridge);
  installInteractionLinks(runtime, linking, bridge);
  expect(linking.addEventListener).toHaveBeenCalledTimes(1);
  resolve('https://example.test/watch/SECRET');
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(1);
  listener({ url: 'https://example.test/watch/SECRET' });
  listener({ url: 'https://example.test/watch/SECRET' });
  expect(send).toHaveBeenCalledTimes(3);
  stop();
  owner = {};
  installInteractionLinks(runtime, linking, bridge);
  expect(linking.getInitialURL).toHaveBeenCalledTimes(1);
  lease = 'B';
  listener({ url: 'https://example.test/help' });
  expect(send.mock.calls.at(-1)?.[0]).toBe('B');
});
it('drops an initial URL resolving after native revocation', async () => {
  vi.resetModules();
  const { installInteractionLinks } = await import('../src/interactions/links.js');
  let lease = 'A';
  let resolve!: (url: string) => void;
  const owner = {};
  const send = vi.fn();
  installInteractionLinks(
    { interactionEvents: { policy, owner: () => owner } },
    {
      addEventListener: () => ({ remove() {} }),
      getInitialURL: () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    },
    { getInteractionLease: () => lease, recordInteraction: send },
  );
  lease = 'B';
  resolve('https://example.test/watch/SECRET');
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
});
