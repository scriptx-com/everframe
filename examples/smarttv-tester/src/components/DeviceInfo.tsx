// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Read-only panel describing the runtime the tester landed on. Useful to
// confirm the chromium-milestone runner actually launched the milestone you
// asked for, and which TV platform a packaged build detects.
import * as React from 'react';

export type TvPlatform = 'tizen' | 'webos' | 'browser';

export function detectPlatform(): TvPlatform {
  const w = window as unknown as Record<string, unknown>;
  const ua = navigator.userAgent;
  if (typeof w.tizen !== 'undefined' || /Tizen/i.test(ua)) return 'tizen';
  if (typeof w.webOS !== 'undefined' || /Web0S|webOS|NetCast/i.test(ua)) return 'webos';
  return 'browser';
}

export function chromeMajor(): string {
  const m = /Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent);
  return m?.[1] ?? 'n/a';
}

const row: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: 18,
  lineHeight: '28px',
};

export function DeviceInfo(): React.JSX.Element {
  const platform = detectPlatform();
  return (
    <section>
      <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>Device</h2>
      <div style={row}>
        <span style={{ opacity: 0.6 }}>Platform</span>
        <span>{platform}</span>
      </div>
      <div style={row}>
        <span style={{ opacity: 0.6 }}>Engine</span>
        <span>Chromium {chromeMajor()}</span>
      </div>
      <div style={row}>
        <span style={{ opacity: 0.6 }}>Viewport</span>
        <span>
          {window.innerWidth}x{window.innerHeight}
        </span>
      </div>
      <p style={{ fontSize: 13, opacity: 0.5, wordBreak: 'break-all', marginTop: 8 }}>
        {navigator.userAgent}
      </p>
    </section>
  );
}
