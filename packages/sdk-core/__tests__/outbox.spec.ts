// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { createInMemoryOutbox } from '../src/queue/outbox.js';

describe('createInMemoryOutbox', () => {
  it('enqueue/list/delete cycle, list sorted by enqueuedAt asc', async () => {
    const outbox = createInMemoryOutbox();
    await outbox.enqueue({
      reportId: 'r1',
      enqueuedAt: 100,
      attempts: 0,
      payload: new Uint8Array(),
      metadata: {},
    });
    await outbox.enqueue({
      reportId: 'r2',
      enqueuedAt: 50,
      attempts: 0,
      payload: new Uint8Array(),
      metadata: {},
    });
    let list = await outbox.list();
    expect(list.map((i) => i.reportId)).toEqual(['r2', 'r1']);
    await outbox.delete('r2');
    list = await outbox.list();
    expect(list.map((i) => i.reportId)).toEqual(['r1']);
  });

  it('overwrites items with the same reportId', async () => {
    const outbox = createInMemoryOutbox();
    await outbox.enqueue({
      reportId: 'r1',
      enqueuedAt: 100,
      attempts: 0,
      payload: new Uint8Array(),
      metadata: {},
    });
    await outbox.enqueue({
      reportId: 'r1',
      enqueuedAt: 200,
      attempts: 1,
      payload: new Uint8Array(),
      metadata: {},
    });
    const list = await outbox.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.attempts).toBe(1);
    expect(list[0]!.enqueuedAt).toBe(200);
  });
});
