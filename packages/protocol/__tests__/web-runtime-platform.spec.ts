// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, it } from 'vitest';
import * as protocol from '../src/index.js';
it.each([
  ['Mozilla/5.0 (Linux; Android 14) Chrome/120', 'web'],
  ['', 'web'],
  ['Mozilla Linux Tizen 7 SMART-TV', 'tizen'],
  ['Mozilla Web0S Linux', 'webos'],
  ['WebAppManager', 'webos'],
  ['webOS', 'webos'],
  ['Linux VIDAA', 'vidaa'],
  ['Linux TitanOS', 'titanos'],
  ['Vega/1.0', 'vega'],
  [
    'Mozilla/5.0 (Linux; Kepler 2.0; AFTCA002 user/515; wv) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Chrome/144.0.7559.246 Safari/537.36',
    'vega',
  ],
  ['Mozilla/5.0 (Linux; Android 9; AFTMM) AppleWebKit/537.36', 'web'],
  ['unknown SmartTV', 'web'],
])('classifies %s as %s', (ua, platform) => {
  expect((protocol as any).detectWebRuntimePlatform?.(ua)).toBe(platform);
});
