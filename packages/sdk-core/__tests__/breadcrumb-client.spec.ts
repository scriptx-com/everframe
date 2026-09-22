// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { createClient, __internalClientState } from '../src/client.js';
import { createFakePlatformAdapter } from '../src/__test-helpers__/fake-platform-adapter.js';

const freshClient = () => {
  const client = createClient(createFakePlatformAdapter());
  client.init({ apiKey: 'k' });
  return client;
};

const frozenChain = (client: ReturnType<typeof freshClient>) => {
  const buf = __internalClientState.get(client)!.breadcrumbs;
  buf.freeze();
  return buf.takeFrozen() ?? [];
};

describe('TraceItXClient.addBreadcrumb', () => {
  it('pushes a custom crumb by default', () => {
    const client = freshClient();
    client.addBreadcrumb({ message: 'checkout started' });
    expect(frozenChain(client)).toMatchObject([{ kind: 'custom', message: 'checkout started' }]);
  });

  it('accepts explicit kind, level, and data', () => {
    const client = freshClient();
    client.addBreadcrumb({
      kind: 'navigation', level: 'info', message: '/a → /b', data: { from: '/a', to: '/b' },
    });
    expect(frozenChain(client)[0]).toMatchObject({
      kind: 'navigation', level: 'info', data: { from: '/a', to: '/b' },
    });
  });

  it('coerces an unknown kind to custom (never throws — safeWrap doctrine)', () => {
    const client = freshClient();
    client.addBreadcrumb({ kind: 'scroll' as never, message: 'x' });
    expect(frozenChain(client)[0]).toMatchObject({ kind: 'custom' });
  });

  it('drops an invalid level but still buffers the crumb (coerce-never-throw)', () => {
    const client = freshClient();
    client.addBreadcrumb({ message: 'x', level: 'FATAL' as never });
    const chain = frozenChain(client);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ kind: 'custom', message: 'x' });
    expect(chain[0]).not.toHaveProperty('level');
  });

  it('is a no-op before init and after kill', () => {
    const adapter = createFakePlatformAdapter();
    const uninit = createClient(adapter);
    uninit.addBreadcrumb({ message: 'dropped' });
    expect(frozenChain(uninit as ReturnType<typeof freshClient>)).toHaveLength(0);

    const killed = freshClient();
    killed.kill();
    killed.addBreadcrumb({ message: 'dropped' });
    expect(__internalClientState.get(killed)!.breadcrumbs.size).toBe(0);
  });

  it('kill() zeroizes the breadcrumb buffer, including crumbs added BEFORE kill', () => {
    const client = freshClient();
    client.addBreadcrumb({ message: 'added before kill' });
    expect(__internalClientState.get(client)!.breadcrumbs.size).toBe(1);
    client.kill();
    expect(__internalClientState.get(client)!.breadcrumbs.size).toBe(0);
  });

  it('ignores a malformed call (non-string message) instead of throwing', () => {
    const client = freshClient();
    client.addBreadcrumb({ message: 42 as never });
    expect(__internalClientState.get(client)!.breadcrumbs.size).toBe(0);
  });

  it('redacts through the configured redaction (mask-before-bytes end-to-end)', () => {
    const client = freshClient();
    client.addBreadcrumb({ message: 'card 4242424242424242' });
    expect(frozenChain(client)[0]!.message).not.toContain('4242424242424242');
  });
});

describe('public exports', () => {
  it('exposes the breadcrumbs surface from the package root', async () => {
    const root = await import('../src/index.js');
    for (const name of [
      'createBreadcrumbBuffer', 'MAX_BREADCRUMBS', 'trimBreadcrumbs', 'crumbCost',
      'truncateMiddle', 'isTrimMarker', 'BREADCRUMB_BYTE_BUDGET', 'CONSOLE_ENTRY_CAP',
      'deriveLogsFromBreadcrumbs', 'deriveNetworkFromBreadcrumbs',
      'BreadcrumbsConfig', 'BREADCRUMBS_CONFIG_DEFAULT', 'getBreadcrumbsConfig',
    ]) {
      expect(root, `missing export: ${name}`).toHaveProperty(name);
    }
  });
});
