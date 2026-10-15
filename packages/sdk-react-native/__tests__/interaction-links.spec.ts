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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('sanitizes links without relying on the host runtime URL implementation', () => {
  // Bare RN's URL implementation is incomplete. No host URL implementation
  // may decide which raw characters count as the origin for privacy purposes.
  vi.stubGlobal(
    'URL',
    class {
      constructor() {
        throw new Error('Incomplete host URL implementation');
      }
    },
  );
  const defaults = normalizeInteractionPolicy({});
  for (const raw of [
    'https://example.test/reset/@SENTINEL-SECRET',
    'https://example.test/reset?token=@SENTINEL-SECRET',
    'https://example.test/private:12345',
  ]) {
    expect(sanitizeInteractionUrl(raw, defaults)).toBe('https://example.test');
  }
  const custom = normalizeInteractionPolicy({
    urlRules: [{ origin: 'nocturne://title', routes: ['/:id'] }],
  });
  expect(custom.urlRules).toHaveLength(1);
  expect(sanitizeInteractionUrl('nocturne://title/SECRET', custom)).toBe('nocturne://title/:id');
});
it.each([
  ['myapp:reset?token=SECRET', 'myapp:'],
  ['MYAPP:/reset/SECRET', 'myapp:'],
  ['myapp:', 'myapp:'],
  ['mailto:user@example.test?subject=SECRET', 'mailto:'],
  ['tel:+123456789', 'tel:'],
  ['file:///private/SECRET', 'file:'],
])('retains only the scheme for a valid hostless link %s', (raw, expected) => {
  expect(sanitizeInteractionUrl(raw, policy)).toBe(expected);
});
it.each([
  'https:',
  'https:/reset/SECRET',
  'http://',
  'myapp://',
  'myapp://:123/path',
  'myapp:SECRET%ZZ',
  'myapp:SECRET%C0%AF',
  'myapp:SECRET%00',
  'myapp:SECRET\\path',
  'myapp:SECRET\npath',
  '1app:SECRET',
])('rejects malformed hostless links %s', (raw) => {
  expect(sanitizeInteractionUrl(raw, policy)).toBeUndefined();
});
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

it('subscribes without a native lease and captures only fresh enabled-period links', async () => {
  vi.resetModules();
  const { installInteractionLinks } = await import('../src/interactions/links.js');
  let listener!: (event: { url: string }) => void;
  let lease = '';
  const owner = {};
  const remove = vi.fn();
  const linking = {
    addEventListener: vi.fn((_type: string, fn: typeof listener) => {
      listener = fn;
      return { remove };
    }),
    getInitialURL: vi.fn(async () => 'https://example.test/help'),
  };
  const send = vi.fn();
  const runtime = { interactionEvents: { policy, owner: () => owner } };
  const bridge = { getInteractionLease: () => lease, recordInteraction: send };
  const stop = installInteractionLinks(runtime, linking, bridge);
  expect(linking.addEventListener).toHaveBeenCalledTimes(1);
  listener({ url: 'https://example.test/watch/OLD' });
  lease = 'enabled';
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
  listener({ url: 'https://example.test/watch/FRESH' });
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(send.mock.calls[0][3])).toMatchObject({
    url: 'https://example.test/watch/:id',
    delivery: 'subsequent',
  });
  lease = '';
  listener({ url: 'https://example.test/help' });
  lease = 'reenabled';
  listener({ url: 'https://example.test/help' });
  expect(send).toHaveBeenCalledTimes(2);
  installInteractionLinks(runtime, linking, bridge);
  expect(linking.addEventListener).toHaveBeenCalledTimes(1);
  stop();
  stop();
  listener({ url: 'https://example.test/help' });
  expect(send).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenCalledTimes(1);
  const stopNext = installInteractionLinks(runtime, linking, bridge);
  await Promise.resolve();
  expect(linking.getInitialURL).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(2);
  listener({ url: 'https://example.test/help' });
  expect(send).toHaveBeenCalledTimes(3);
  stopNext();
});
it('does not replay an initial promise after disposal and a fresh mount', async () => {
  vi.resetModules();
  const { installInteractionLinks } = await import('../src/interactions/links.js');
  let resolve!: (url: string) => void;
  let owner = {};
  const send = vi.fn();
  const linking = {
    addEventListener: () => ({ remove() {} }),
    getInitialURL: vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    ),
  };
  const runtime = { interactionEvents: { policy, owner: () => owner } };
  const bridge = { getInteractionLease: () => 'lease', recordInteraction: send };
  const stop = installInteractionLinks(runtime, linking, bridge);
  stop();
  owner = {};
  const stopNext = installInteractionLinks(runtime, linking, bridge);
  resolve('https://example.test/help');
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
  expect(linking.getInitialURL).toHaveBeenCalledTimes(1);
  stopNext();
});
it.each([
  '%2fSECRET',
  '%3Ftoken=SECRET',
  '%23SECRET',
  '%40SECRET',
  '%5cSECRET',
  '%00SECRET',
  '%20SECRET',
  '%7fSECRET',
  '%252fSECRET',
  '%253Ftoken=SECRET',
  '%25252FSECRET',
  '%25253Ftoken=SECRET',
  '%25SECRET',
  '%3A123',
  '%5BSECRET',
  '%5DSECRET',
])(
  'rejects ambiguous encoded authority %s before forwarding or granting policy permissions',
  (host) => {
    const raw = 'nocturne://title' + host;
    expect(sanitizeInteractionUrl(raw, normalizeInteractionPolicy({}))).toBeUndefined();
    const local = normalizeInteractionPolicy({
      urlRules: [{ origin: raw.toLowerCase(), queryKeys: ['token'], routes: ['/:id'] }],
    });
    expect(local.urlRules).toEqual([]);
  },
);
it.each([
  ['nocturne://title/SECRET', 'nocturne://title'],
  ['nocturne://user:password@title:1234/SECRET', 'nocturne://title:1234'],
  ['https://[::1]:8443/SECRET', 'https://[::1]:8443'],
  ['nocturne://[::1]:1234/SECRET', 'nocturne://[::1]:1234'],
])('preserves valid hosts and strips ordinary credentials for %s', (raw, expected) => {
  expect(sanitizeInteractionUrl(raw, normalizeInteractionPolicy({}))).toBe(expected);
  expect(
    normalizeInteractionPolicy({ urlRules: [{ origin: expected, routes: ['/:id'] }] }).urlRules,
  ).toEqual([{ origin: expected, routes: ['/:id'], queryKeys: [], literalPaths: [] }]);
});
it('consumes the initial URL opportunity during a locally disabled mount', async () => {
  vi.resetModules();
  const { installInteractionLinks } = await import('../src/interactions/links.js');
  const owner = {};
  const send = vi.fn();
  let listener!: (event: { url: string }) => void;
  const linking = {
    addEventListener: vi.fn((_type: string, fn: typeof listener) => {
      listener = fn;
      return { remove() {} };
    }),
    getInitialURL: vi.fn(async () => 'https://example.test/help'),
  };
  const bridge = { getInteractionLease: () => 'enabled', recordInteraction: send };
  installInteractionLinks(
    {
      interactionEvents: {
        policy: normalizeInteractionPolicy({ disabled: true }),
        owner: () => owner,
      },
    },
    linking,
    bridge,
  );
  expect(linking.addEventListener).not.toHaveBeenCalled();
  const stop = installInteractionLinks(
    { interactionEvents: { policy, owner: () => owner } },
    linking,
    bridge,
  );
  await Promise.resolve();
  expect(linking.getInitialURL).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  listener({ url: 'https://example.test/help' });
  expect(send).toHaveBeenCalledTimes(1);
  stop();
});
