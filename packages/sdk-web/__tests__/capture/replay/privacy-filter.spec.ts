// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, expect, it } from 'vitest';
import { filterReplayEvent } from '../../../src/capture/replay/privacy-filter.js';
afterEach(() => {
  document.body.innerHTML = '';
});
it('filters sensitive id payloads and added nodes by node or parent while retaining removals', () => {
  document.body.innerHTML =
    '<div data-everframe-sensitive id="host"></div><p id="ordinary">Public</p>';
  const host = document.querySelector('#host')!;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<input><span>Private</span>';
  const mirror = {
    getNode: (id: number) =>
      ({
        1: host,
        2: root.querySelector('input'),
        3: root.querySelector('span'),
        4: document.querySelector('#ordinary'),
      })[id] ?? null,
  };
  expect(
    filterReplayEvent(
      { type: 3, timestamp: 1, data: { source: 5, id: 2, text: 'private' } },
      mirror,
    ),
  ).toBeUndefined();
  const removed = [{ parentId: 1, id: 3 }];
  const result = filterReplayEvent(
    {
      type: 3,
      timestamp: 1,
      data: {
        source: 0,
        texts: [
          { id: 3, value: 'private' },
          { id: 4, value: 'Public' },
        ],
        attributes: [{ id: 3, attributes: { class: 'private' } }],
        adds: [
          { parentId: 1, node: { id: 4 } },
          { parentId: 4, node: { id: 3 } },
          { parentId: 4, node: { id: 99 } },
        ],
        removes: removed,
      },
    },
    mirror,
  )!;
  expect(result.data).toEqual({
    source: 0,
    texts: [{ id: 4, value: 'Public' }],
    attributes: [],
    adds: [],
    removes: removed,
  });
  expect(
    filterReplayEvent({ type: 5, timestamp: 1, data: { payload: { text: 'private' } } }, mirror),
  ).toBeUndefined();
});
