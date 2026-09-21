// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Session Vitals dogfood — index of the playback benches. One page per player
// source, so a single session in the dashboard's Sessions tab shows exactly
// which library produced which timeline.
import Link from 'next/link';

const BENCHES = [
  {
    href: '/playback/native',
    title: 'Native progressive',
    blurb: 'A plain <video> over the local mp4/webm clip. No library — the baseline every other bench is measured against.',
  },
  {
    href: '/playback/hls',
    title: 'hls.js',
    blurb: 'VOD and live HLS through the shipped hls.js integration: manifest and first-fragment startup timings, level switches, real rebuffering.',
  },
  {
    href: '/playback/dash',
    title: 'Shaka Player · DASH',
    blurb: 'A multi-rendition DASH manifest through the shipped Shaka integration: variant adaptation, quality changes, DRM session events.',
  },
] as const;

export default function PlaybackIndex() {
  return (
    <main className="shell">
      <p className="eyebrow">Playback benches · 3 sources</p>
      <h1 className="display" data-testid="playback-heading">
        Playback
      </h1>
      <p className="lede">
        Each bench is one player with a transport strip — play, pause, stop,
        seek, rate — and, where a library sits behind the element, its
        level or variant picker. Tracking is automatic: the player is on the
        page, so the session records it. Drive a bench, then find this
        session under <strong>Sessions</strong> in the dashboard.
      </p>

      <div className="feature-cards" data-testid="playback-benches">
        {BENCHES.map((b) => (
          <Link key={b.href} href={b.href} className="card" data-testid={`bench-${b.href.split('/').pop()}`}>
            <h3>{b.title}</h3>
            <p>{b.blurb}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
