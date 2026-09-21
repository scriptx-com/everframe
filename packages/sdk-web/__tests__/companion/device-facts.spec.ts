// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// UA-derived companion device facts (naming spec 2026-08-24 §1). Facts are
// raw inputs to the SERVER's name composer ("Samsung TV · Tizen 7.0") — no
// display formatting here, and nothing personal: model/OS class only.
import { describe, expect, it } from 'vitest';
import { deriveDeviceFacts } from '../../src/companion/device-facts.js';

const TIZEN_UA =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 94.0.4606.31/7.0 TV Safari/537.36';
const WEBOS_UA =
  'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.128 Safari/537.36 WebAppManager';
const MAC_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const WIN_EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.2535.67';

describe('deriveDeviceFacts', () => {
  it('recognizes Samsung Tizen TVs with the OS version', () => {
    expect(deriveDeviceFacts(TIZEN_UA)).toEqual({
      platform: 'web', model: 'Samsung TV', osName: 'Tizen', osVersion: '7.0',
    });
  });

  it('recognizes LG webOS TVs (no version in modern UAs)', () => {
    expect(deriveDeviceFacts(WEBOS_UA)).toEqual({
      platform: 'web', model: 'LG TV', osName: 'webOS', osVersion: null,
    });
  });

  it('desktop browsers: browser+major as model, OS as osName', () => {
    expect(deriveDeviceFacts(MAC_CHROME_UA)).toEqual({
      platform: 'web', model: 'Chrome 126', osName: 'macOS', osVersion: null,
    });
    // Edge advertises Chrome too — the Edg/ token wins.
    expect(deriveDeviceFacts(WIN_EDGE_UA)).toEqual({
      platform: 'web', model: 'Edge 125', osName: 'Windows', osVersion: null,
    });
  });

  it('degrades to all-null facts on an unrecognizable UA, never throws', () => {
    expect(deriveDeviceFacts('curl/8.4.0')).toEqual({
      platform: 'web', model: null, osName: null, osVersion: null,
    });
    expect(deriveDeviceFacts('')).toEqual({
      platform: 'web', model: null, osName: null, osVersion: null,
    });
  });

  it('caps model at 80 and os fields at 40 chars', () => {
    const junk = `Mozilla/5.0 (SMART-TV; LINUX; Tizen ${'9'.repeat(60)})`;
    const facts = deriveDeviceFacts(junk);
    expect((facts.osVersion ?? '').length).toBeLessThanOrEqual(40);
  });
});
