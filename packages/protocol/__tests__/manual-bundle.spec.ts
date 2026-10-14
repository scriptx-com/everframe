// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, it } from 'vitest';
import { ReportEnvelope } from '../src/envelope.js';
import { baseEnvelope } from './helpers/base-envelope.js';
it.each(['ios', 'android'])('preserves exact %s bundle context on ordinary reports', (platform) => {
  const env = baseEnvelope();
  env.sdk.platform = platform;
  env.context.app.jsBundle = {
    engine: 'hermes',
    platform,
    buildId: 'OTA-A',
    bundleName: 'main.jsbundle',
  };
  expect(ReportEnvelope.parse(env).context.app.jsBundle).toEqual(env.context.app.jsBundle);
  expect(ReportEnvelope.parse(env).payload.crash).toBeUndefined();
  env.context.app.jsBundle.buildId = '';
  expect(ReportEnvelope.safeParse(env).success).toBe(false);
  delete env.context.app.jsBundle;
  expect(ReportEnvelope.safeParse(env).success).toBe(true);
});
