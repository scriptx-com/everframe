// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { normalizeInteractionPolicy } from '../src/interactions/policy.js';

describe('local interaction privacy policy', () => {
  it('defaults to structural capture without any value allowlist', () => {
    expect(normalizeInteractionPolicy(undefined)).toEqual({
      disabled: false,
      valueTestIds: [],
      urlRules: [],
      launchArgumentKeys: [],
    });
  });
  it('admits exact local identifiers and rejects wildcard authorization', () => {
    expect(
      normalizeInteractionPolicy({
        valueTestIds: ['search-input', '*', 'Search', 'search-input'],
        launchArgumentKeys: ['mode'],
      }),
    ).toEqual({
      disabled: false,
      valueTestIds: ['search-input', 'Search'],
      urlRules: [],
      launchArgumentKeys: ['mode'],
    });
  });
  it('rejects an oversized list as a whole', () => {
    expect(
      normalizeInteractionPolicy({
        valueTestIds: Array.from({ length: 65 }, (_, i) => `field${i}`),
      }).valueTestIds,
    ).toEqual([]);
  });
  it('does not read inherited or accessor-backed permissions', () => {
    expect(
      normalizeInteractionPolicy(Object.create({ valueTestIds: ['password'] })).valueTestIds,
    ).toEqual([]);
    let reads = 0;
    const input = {
      get valueTestIds() {
        reads++;
        return ['password'];
      },
    };
    expect(normalizeInteractionPolicy(input).valueTestIds).toEqual([]);
    expect(reads).toBe(0);
    expect(
      normalizeInteractionPolicy(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw Error('host');
            },
          },
        ),
      ).valueTestIds,
    ).toEqual([]);
  });
  it('fails closed when disabled is malformed or supplied through an accessor', () => {
    expect(
      normalizeInteractionPolicy({ disabled: 'false', valueTestIds: ['secret'] }).disabled,
    ).toBe(true);
    expect(
      normalizeInteractionPolicy({
        get disabled() {
          return false;
        },
        valueTestIds: ['secret'],
      }).disabled,
    ).toBe(true);
  });
  it('scopes query permissions and routes to a safe exact origin', () => {
    expect(
      normalizeInteractionPolicy({
        urlRules: [
          {
            origin: 'https://example.com',
            queryKeys: ['q', '*'],
            routes: ['/title/:id'],
            literalPaths: ['/search'],
          },
          { origin: 'https://user:pass@example.com', queryKeys: ['token'] },
          { origin: 'https://example.com/path', queryKeys: ['token'] },
          { origin: '*', queryKeys: ['token'] },
        ],
      }).urlRules,
    ).toEqual([
      {
        origin: 'https://example.com',
        queryKeys: ['q'],
        routes: ['/title/:id'],
        literalPaths: ['/search'],
      },
    ]);
  });
  it('rejects malformed identifiers without truncating them into authorization', () => {
    expect(
      normalizeInteractionPolicy({
        valueTestIds: ['a'.repeat(257), ' bad ', '\ud800'],
        launchArgumentKeys: ['x'.repeat(129)],
      }).valueTestIds,
    ).toEqual([]);
    expect(
      normalizeInteractionPolicy({ launchArgumentKeys: ['x'.repeat(129)] }).launchArgumentKeys,
    ).toEqual([]);
  });
});
