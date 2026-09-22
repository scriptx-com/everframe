// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sampleAndWarn, __resetWarned } from '../src/displayname-heuristic.js';

describe('PAY-06 prep: displayname-heuristic', () => {
  beforeEach(() => {
    __resetWarned();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns when >50% of sampled names look mangled', () => {
    const names = [
      'a',
      '_a',
      'b',
      'c1',
      'd',
      'e',
      '_b',
      'f',
      'g',
      'h',
      'i',
      'j',
      'GoodName1',
      'GoodName2',
      'GoodName3',
      'GoodName4',
      'GoodName5',
      undefined,
      undefined,
      undefined,
    ];
    sampleAndWarn(names, 20);
    expect(console.warn).toHaveBeenCalledOnce();
    const firstCall = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(firstCall?.[0]).toMatch(/babel-plugin-displayname|swc-plugin-displayname/);
  });

  it('does not warn when <=50% mangled', () => {
    const names = [
      'GoodNameA',
      'GoodNameB',
      'GoodNameC',
      'GoodNameD',
      'GoodNameE',
      'GoodNameF',
      'GoodNameG',
      'GoodNameH',
      'GoodNameI',
      'GoodNameJ',
      'GoodNameK',
      'GoodNameL',
      'GoodNameM',
      'GoodNameN',
      'GoodNameO',
      'a',
      'b',
      'c',
      'd',
      'e',
    ];
    sampleAndWarn(names, 20);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns at most once across multiple calls', () => {
    const names = [
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
      'l',
      'm',
      'n',
      'o',
      'p',
      'q',
      'r',
      's',
      't',
    ];
    sampleAndWarn(names, 20);
    sampleAndWarn(names, 20);
    expect(console.warn).toHaveBeenCalledOnce();
  });
});
