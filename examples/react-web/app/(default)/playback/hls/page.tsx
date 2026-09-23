// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Playback bench — hls.js. Two players in one session: a multi-level VOD
// manifest and a live stream, both through the shipped hls.js integration
// (`trackPlayer({ hls })`), so the timeline carries manifest / first-fragment
// startup timings and `bitrate_change` on every level switch.
//
// The level picker is what makes those level switches DELIBERATE: with ABR
// on, whether you ever see a switch depends on the network; pinning a level
// produces one on demand.
'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Hls, { type Level } from 'hls.js';
import { useTrackPlayer } from '@everframe/react';
import { PlayerBench } from '../../../components/PlayerBench';
import { HLS_LIVE_URL, HLS_VOD_URL } from '../../../lib/media';

/**
 * Decided in an effect, never during render: `Hls.isSupported()` probes
 * `MediaSource`, which does not exist on the server, so a render-time check
 * would mismatch on hydration. `native` is Safari's built-in HLS — the
 * element plays the manifest itself, and the adapter tracks it with no
 * integration at all, which is a legitimate second thing to see working.
 */
type Mode = 'pending' | 'mse' | 'native';

interface HlsBenchProps {
  url: string;
  name: string;
  title: string;
  kind: 'VOD' | 'live';
  note: string;
  testid: string;
}

function HlsBench({ url, name, title, kind, note, testid }: HlsBenchProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<Mode>('pending');
  const [hls, setHls] = useState<Hls | null>(null);
  const [levels, setLevels] = useState<Level[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    setMode(Hls.isSupported() ? 'mse' : 'native');
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (mode !== 'mse' || !el) return undefined;
    const h = new Hls();
    h.on(Hls.Events.MANIFEST_PARSED, (_, data) => setLevels(data.levels));
    h.on(Hls.Events.LEVEL_SWITCHED, (_, data) => setCurrentLevel(data.level));
    h.attachMedia(el);
    setHls(h);
    return () => {
      h.destroy();
      setHls(null);
      setLevels([]);
    };
  }, [mode]);

  useTrackPlayer(ref, useMemo(() => (hls ? { hls, name } : { name }), [hls, name]));

  // loadSource() must run AFTER useTrackPlayer's own effect has attached:
  // hls.js fires its manifest-loading event synchronously from loadSource(),
  // but the integration only establishes its timing baseline
  // (manifestMs / firstFragmentMs) when it attaches. useTrackPlayer's attach
  // happens on the render where `hls` transitions to non-null — the SAME
  // render this effect fires on — and because it is declared earlier in this
  // component, React runs its effect first (hooks in one component commit in
  // declaration order). A later, separate effect is what guarantees that
  // ordering instead of racing it.
  useEffect(() => {
    if (hls) hls.loadSource(url);
  }, [hls, url]);

  const pickLevel = (i: number) => {
    if (!hls) return;
    hls.currentLevel = i; // -1 hands control back to ABR
    setAuto(i === -1);
  };

  const state = mode === 'native'
    ? `native HLS · ${kind} · no integration`
    : `hls.js${hls ? ` ${Hls.version}` : ''} · ${kind}${levels.length ? ` · ${levels.length} levels` : ''}`;

  return (
    <PlayerBench
      title={title}
      state={state}
      note={note}
      testid={testid}
      videoRef={ref}
      extraControls={
        mode === 'mse' && levels.length > 0 ? (
          <div className="btn-row" data-testid={`${testid}-levels`}>
            <span className="player-bench-label">Level</span>
            <button type="button" className="chip" aria-pressed={auto} onClick={() => pickLevel(-1)}>
              Auto{auto && currentLevel >= 0 && levels[currentLevel] ? ` (${levels[currentLevel].height}p)` : ''}
            </button>
            {levels.map((l, i) => (
              <button
                key={`${l.bitrate}-${i}`}
                type="button"
                className="chip"
                aria-pressed={!auto && currentLevel === i}
                onClick={() => pickLevel(i)}
              >
                {l.height ? `${l.height}p` : `L${i}`} · {Math.round(l.bitrate / 1000)} kbps
              </button>
            ))}
          </div>
        ) : null
      }
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- third-party test stream */}
      <video
        ref={ref}
        controls
        muted
        playsInline
        width={640}
        height={360}
        src={mode === 'native' ? url : undefined}
        data-testid={`${testid}-video`}
      />
    </PlayerBench>
  );
}

export default function HlsPlaybackPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Playback bench · hls.js</p>
      <h1 className="display" data-testid="hls-heading">
        HLS
      </h1>
      <p className="lede">
        Two players, one session. The VOD manifest has several levels — pin
        one to force a <code>bitrate_change</code>; the live stream is the
        only place the seekable window moves under you. On Safari both fall
        back to the browser's own HLS with no integration attached.
      </p>

      <div className="player-bench-grid">
        <HlsBench
          url={HLS_VOD_URL}
          name="hls-vod"
          kind="VOD"
          title="Big Buck Bunny"
          note="Multi-level VOD. Seek far ahead to force a rebuffer; pin a level to force a switch."
          testid="hls-vod"
        />
        <HlsBench
          url={HLS_LIVE_URL}
          name="hls-live"
          kind="live"
          title="Live test stream"
          note="Unbounded duration; the scrub bar tracks the DVR window. Third-party stream — override NEXT_PUBLIC_DEMO_HLS_LIVE_URL if it has gone away."
          testid="hls-live"
        />
      </div>
    </main>
  );
}
