// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Replays on errors (spec 2026-10-11, "Protocol"). An error reported while the
// app keeps running may carry ONE session-replay attachment, in exactly the
// shapes bug reports use: `rrweb` on web, `everframe-video-v1` MP4 on mobile.
// No schema change was needed: below the evidence branches the envelope rules
// never restricted attachments. This file pins that. Evidence envelopes (Apple
// diagnostics, recovered stalls, Android OS exit evidence, inferred
// terminations) stay attachment-free; their own specs each pin a session-replay row.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ReportEnvelope } from '../src/index.js';
import { rrwebReplayRef, videoReplayRef } from './helpers/replay-attachment.js';

const fixture = () =>
  JSON.parse(readFileSync(new URL('./fixtures/crash-report.json', import.meta.url), 'utf8'));

const SDKS = {
  web: { name: 'everframe-web', platform: 'web', formFactor: 'desktop', replay: rrwebReplayRef },
  android: {
    name: 'everframe-android',
    platform: 'android',
    formFactor: 'phone',
    replay: videoReplayRef,
  },
  ios: { name: 'everframe-ios', platform: 'ios', formFactor: 'phone', replay: videoReplayRef },
  tvos: { name: 'everframe-ios', platform: 'tvos', formFactor: 'tv', replay: videoReplayRef },
  'react-native': {
    name: 'everframe-react-native',
    platform: 'android',
    formFactor: 'phone',
    replay: videoReplayRef,
  },
} as const;

/** A handled error from a running app, attributable like any report. */
function runningError(sdk: keyof typeof SDKS) {
  const v = fixture();
  const s = SDKS[sdk];
  v.source = 'error';
  v.sdk = { name: s.name, version: '1.0.0', platform: s.platform, formFactor: s.formFactor };
  Object.assign(v.payload.crash, { handled: true, fatal: false, mechanism: 'captureException' });
  v.sessionId = '22222222-2222-4222-8222-222222222222';
  v.reporter.user = { id: 'user-1' };
  v.attachments = [s.replay()];
  return v;
}

const issues = (value: unknown) => {
  const parsed = ReportEnvelope.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('an error reported while the app runs carries its replay', () => {
  it.each(['web', 'android', 'ios', 'tvos', 'react-native'] as const)(
    'accepts one session-replay attachment from %s',
    (sdk) => {
      expect(issues(runningError(sdk))).toEqual([]);
      expect(ReportEnvelope.parse(runningError(sdk)).attachments).toHaveLength(1);
    },
  );

  it('accepts it on an unhandled error the page survives (window.onerror, unhandled rejection)', () => {
    const v = runningError('web');
    Object.assign(v.payload.crash, { handled: false, mechanism: 'onerror' });
    expect(issues(v)).toEqual([]);
  });

  it('accepts it on a web React render error no boundary caught (fatal to the React tree, the page stays alive)', () => {
    const v = runningError('web');
    v.source = 'crash';
    Object.assign(v.payload.crash, { handled: false, fatal: true, mechanism: 'onerror' });
    expect(issues(v)).toEqual([]);
  });

  it('keeps the bug-report video rules on an error replay', () => {
    const v = runningError('android');
    delete v.attachments[0].width;
    expect(issues(v)).toContain('Video replay requires a positive integer dimension');
  });
});
