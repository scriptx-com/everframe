// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { describeWebRuntimeDevice, webOsAppIdFromPath } from '../src/index.js';

// User agents from production reports, October 2026, unless noted.
const TIZEN_9 =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36';
const WEBOS_25 =
  'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.270 Safari/537.36 WebAppManager';
const WEBOS_6 =
  'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager';
const TITAN =
  'Mozilla/5.0 (Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.4147.62 Safari/537.36 OPR/46.0.2207.0 OMI/4.24, TV_NT72690_2025_4K/056.010.026.001 (Philips, PUS7000) CE-HTML/1.0 NETTV/4.6.0.8 SignOn/2.0 SmartTvA/5.0.0 WhaleTV/2.0 TitanOS/3.0 en Ginga';
const KEPLER =
  'Mozilla/5.0 (Linux; Kepler 2.0; AFTCA002 user/515; wv) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Chrome/144.0.7559.246 Safari/537.36';
// Not yet seen in production: the shape VIDAA documents.
const VIDAA =
  'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.102 Safari/537.36 VIDAA/7.0 HbbTV/1.5.1 (+DRM; Hisense; 55A7KQ; V0000.07.00T; ; ;)';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

describe('describeWebRuntimeDevice', () => {
  it('reads a Samsung Tizen TV', () => {
    expect(describeWebRuntimeDevice(TIZEN_9)).toEqual({
      platform: 'tizen',
      tv: true,
      os: 'Tizen',
      osVersion: '9.0',
      manufacturer: 'Samsung',
      runtimeVersions: { chrome: '120.0.6099.5' },
    });
  });

  it('names the webOS release that ships the Chromium', () => {
    expect(describeWebRuntimeDevice(WEBOS_25)).toMatchObject({
      platform: 'webos',
      tv: true,
      os: 'webOS',
      osVersion: '25',
      manufacturer: 'LG',
    });
    expect(describeWebRuntimeDevice(WEBOS_6).osVersion).toBe('6');
  });

  it('leaves a webOS version unknown for an unpublished Chromium', () => {
    const ua = WEBOS_25.replace('Chrome/120.0.6099.270', 'Chrome/132.0.0.1');
    expect(describeWebRuntimeDevice(ua).osVersion).toBeUndefined();
  });

  it('reads the maker and model a Titan OS TV prints', () => {
    expect(describeWebRuntimeDevice(TITAN)).toMatchObject({
      platform: 'titanos',
      os: 'Titan OS',
      osVersion: '3.0',
      manufacturer: 'Philips',
      model: 'PUS7000',
    });
  });

  it('reads a Vega OS web view as an Amazon device', () => {
    expect(describeWebRuntimeDevice(KEPLER)).toEqual({
      platform: 'vega',
      tv: true,
      os: 'Vega OS',
      osVersion: '2.0',
      manufacturer: 'Amazon',
      model: 'AFTCA002',
      runtimeVersions: { chrome: '144.0.7559.246' },
    });
  });

  it('reads a VIDAA TV and its HbbTV model', () => {
    expect(describeWebRuntimeDevice(VIDAA)).toMatchObject({
      platform: 'vidaa',
      os: 'VIDAA',
      osVersion: '7.0',
      manufacturer: 'Hisense',
      model: '55A7KQ',
    });
  });

  it('prefers the maker the HbbTV token names over the platform default', () => {
    const toshiba = VIDAA.replace('(+DRM; Hisense; 55A7KQ;', '(+DRM; Toshiba; 55UA5D63DG;');
    expect(describeWebRuntimeDevice(toshiba)).toMatchObject({
      platform: 'vidaa',
      manufacturer: 'Toshiba',
      model: '55UA5D63DG',
    });
  });

  it('marks a Fire TV web view as a TV but keeps it web', () => {
    expect(
      describeWebRuntimeDevice('Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7633) Chrome/120.0'),
    ).toMatchObject({ platform: 'web', tv: true, manufacturer: 'Amazon', model: 'AFTMM' });
  });

  it('says only the engine for a desktop browser', () => {
    expect(describeWebRuntimeDevice(MAC)).toEqual({
      platform: 'web',
      tv: false,
      runtimeVersions: { chrome: '155.0.0.0' },
    });
    expect(describeWebRuntimeDevice(undefined)).toEqual({ platform: 'web', tv: false });
  });
});

describe('webOsAppIdFromPath', () => {
  it('reads the app ID from a packaged app path', () => {
    expect(
      webOsAppIdFromPath('/media/developer/apps/usr/palm/applications/com.mwaretv.app/index.html'),
    ).toBe('com.mwaretv.app');
  });
  it('is undefined for any other path', () => {
    expect(webOsAppIdFromPath('/index.html')).toBeUndefined();
    expect(webOsAppIdFromPath(null)).toBeUndefined();
  });
});
