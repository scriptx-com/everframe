// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { createOutbox, fit, MAX_AGE_MS, MAX_ATTEMPTS, MAX_ITEMS, OUTBOX_KEY, type OutboxDeps, type OutboxItem } from '../src/outbox.js';
import { createStorage, stored } from './fakes.js';

const BINDING = { endpoint: 'https://everframe.dev/api/ingest', keyHash: 'a'.repeat(32) };

const item = (reportId: string, extra: Partial<OutboxItem> = {}): OutboxItem => ({
  reportId, body: `{"reportId":"${reportId}"}`, enqueuedAt: 1_000, attempts: 0, fatal: false, ...BINDING, ...extra,
});

const deps = (over: Partial<OutboxDeps> & Pick<OutboxDeps, 'storage'>): OutboxDeps => ({
  now: () => 2_000, warn: () => undefined, binding: BINDING, debug: () => undefined, ...over,
});

describe('outbox', () => {
  it('persists every add and reloads it in the next launch', async () => {
    const storage = createStorage();
    const first = createOutbox(deps({ storage, now: () => 2_000, warn: () => undefined }));
    await first.add(item('a'));
    await first.add(item('b', { fatal: true }));
    expect(stored(storage).map((i) => i.reportId)).toEqual(['a', 'b']);

    const next = createOutbox(deps({ storage, now: () => 3_000, warn: () => undefined }));
    await next.ready;
    expect((await next.due()).map((i) => i.reportId)).toEqual(['a', 'b']);
  });

  it('does not overwrite stored reports with a capture made while loading', async () => {
    const storage = createStorage({ deferLoad: true, initial: [item('from-last-launch', { fatal: true })] });
    const outbox = createOutbox(deps({ storage, now: () => 2_000, warn: () => undefined }));
    const adding = outbox.add(item('new'));
    await Promise.resolve();
    expect(storage.writes).toEqual([]);
    storage.releaseLoad();
    await adding;
    expect(stored(storage).map((i) => i.reportId)).toEqual(['from-last-launch', 'new']);
  });

  it('removes, counts attempts and drops expired items', async () => {
    let now = 2_000;
    const storage = createStorage();
    const outbox = createOutbox(deps({ storage, now: () => now, warn: () => undefined }));
    await outbox.add(item('a'));
    await outbox.add(item('b'));
    await outbox.add(item('old', { enqueuedAt: now - MAX_AGE_MS - 1 }));
    await outbox.add(item('tired', { attempts: MAX_ATTEMPTS - 1 }));
    await outbox.recordAttempt('tired');
    await outbox.remove('a');
    expect((await outbox.due()).map((i) => i.reportId)).toEqual(['b']);
    expect(stored(storage).map((i) => i.reportId)).toEqual(['b']);
    now += 1;
    expect(outbox.size()).toBe(1);
  });

  it('keeps fatal reports when it has to drop', () => {
    const items = [item('fatal-1', { fatal: true }), ...Array.from({ length: MAX_ITEMS + 2 }, (_, i) => item(`e${i}`))];
    const kept = fit(items);
    expect(kept).toHaveLength(MAX_ITEMS);
    expect(kept[0]!.reportId).toBe('fatal-1');
    expect(kept.at(-1)!.reportId).toBe(`e${MAX_ITEMS + 1}`);
  });

  it('caps the serialized size', () => {
    const big = 'x'.repeat(200 * 1024);
    const kept = fit([item('a', { body: big }), item('b', { body: big }), item('c', { body: big })]);
    expect(kept.map((i) => i.reportId)).toEqual(['b', 'c']);
  });

  it('treats unreadable storage as empty and replaces it', async () => {
    const storage = createStorage();
    storage.data.set(OUTBOX_KEY, '{not json');
    const outbox = createOutbox(deps({ storage, now: () => 2_000, warn: () => undefined }));
    await outbox.add(item('a'));
    expect(stored(storage).map((i) => i.reportId)).toEqual(['a']);

    storage.data.set(OUTBOX_KEY, JSON.stringify([{ reportId: 1 }, item('ok'), item('ok')]));
    const reloaded = createOutbox(deps({ storage, now: () => 2_000, warn: () => undefined }));
    expect((await reloaded.due()).map((i) => i.reportId)).toEqual(['ok']);
  });

  it('keeps reports in memory and warns once when writes fail', async () => {
    const storage = createStorage();
    storage.failWrites = true;
    const warnings: string[] = [];
    const outbox = createOutbox(deps({ storage, now: () => 2_000, warn: (m) => warnings.push(m) }));
    await outbox.add(item('a'));
    await outbox.add(item('b'));
    expect(outbox.size()).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  it('works without storage', async () => {
    const outbox = createOutbox(deps({ storage: undefined }));
    await outbox.add(item('a'));
    expect((await outbox.due()).map((i) => i.reportId)).toEqual(['a']);
  });

  describe('binding to the SDK key and endpoint', () => {
    it('drops, never loads, reports captured for another key or endpoint, and removes them from storage', async () => {
      const otherKey = item('other-key', { keyHash: 'b'.repeat(32) });
      const otherEndpoint = item('other-endpoint', { endpoint: 'http://127.0.0.1:8790/api/ingest' });
      const unbound = { reportId: 'legacy', body: '{}', enqueuedAt: 1_000, attempts: 0, fatal: true };
      const storage = createStorage({ initial: [otherKey, otherEndpoint, unbound as never, item('mine')] });
      const debug: string[] = [];
      const outbox = createOutbox(deps({ storage, debug: (m) => debug.push(m) }));
      expect((await outbox.due()).map((i) => i.reportId)).toEqual(['mine']);
      expect(stored(storage).map((i) => i.reportId)).toEqual(['mine']);
      expect(debug).toEqual(['[everframe] dropped 2 stored report(s) captured for another SDK key or endpoint; they are not sent']);
    });

    it('cleans storage on load even when nothing else is written', async () => {
      const storage = createStorage({ initial: [item('foreign', { keyHash: 'b'.repeat(32) })] });
      const outbox = createOutbox(deps({ storage }));
      await outbox.ready;
      await outbox.due();
      expect(stored(storage)).toEqual([]);
    });

    it('refuses to add a report bound elsewhere', async () => {
      const storage = createStorage();
      const outbox = createOutbox(deps({ storage }));
      await outbox.add(item('elsewhere', { endpoint: 'https://other.example/api/ingest' }));
      expect(outbox.size()).toBe(0);
    });
  });
});
