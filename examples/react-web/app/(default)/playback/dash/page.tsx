// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Playback bench — Shaka Player over DASH, through the shipped Shaka
// integration (`trackPlayer({ shaka })`). Shaka reports adaptation through
// its own `adaptation` / `variantchanged` events, and the variant picker
// below forces those on demand instead of leaving them to the network.
//
// Shaka is loaded with a dynamic import inside an effect, never at module
// scope: its compiled bundle reaches for `window` when it evaluates, and a
// client component still renders once on the server.
'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type shaka from 'shaka-player';
import { useTrackPlayer } from '@traceitx/react';
import { PlayerBench } from '../../../components/PlayerBench';
import { DASH_URL } from '../../../lib/media';

type ShakaPlayer = shaka.Player;
type VariantTrack = shaka.extern.Track;

function fmtVariant(t: VariantTrack): string {
  const res = t.height ? `${t.height}p` : `#${t.id}`;
  return `${res} · ${Math.round(t.bandwidth / 1000)} kbps`;
}

export default function DashPlaybackPage() {
  const ref = useRef<HTMLVideoElement>(null);
  const [player, setPlayer] = useState<ShakaPlayer | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [variants, setVariants] = useState<VariantTrack[]>([]);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let cancelled = false;
    let p: ShakaPlayer | null = null;

    (async () => {
      const lib = (await import('shaka-player')).default;
      if (cancelled) return;
      lib.polyfill.installAll();
      if (!lib.Player.isBrowserSupported()) {
        setUnsupported(true);
        return;
      }
      p = new lib.Player();
      const refresh = () => setVariants(p?.getVariantTracks() ?? []);
      p.addEventListener('loaded', refresh);
      p.addEventListener('adaptation', refresh);
      p.addEventListener('variantchanged', refresh);
      await p.attach(el);
      if (cancelled) return;
      setVersion(lib.Player.version);
      setPlayer(p);
    })().catch(() => setUnsupported(true));

    return () => {
      cancelled = true;
      setPlayer(null);
      setVariants([]);
      p?.destroy().catch(() => undefined);
    };
  }, []);

  useTrackPlayer(ref, useMemo(() => (player ? { shaka: player, name: 'dash' } : { name: 'dash' }), [player]));

  // load() must run AFTER useTrackPlayer's effect has attached — Shaka fires
  // `loading` from load(), and the integration's startup baseline is set on
  // attach. `player` becomes non-null on the render where both effects fire;
  // this one is declared later, so it runs later. Same rule as the hls bench.
  useEffect(() => {
    if (player) player.load(DASH_URL).catch(() => undefined);
  }, [player]);

  const pickVariant = (t: VariantTrack | null) => {
    if (!player) return;
    if (t) {
      player.configure('abr.enabled', false);
      player.selectVariantTrack(t, true);
      setAuto(false);
    } else {
      player.configure('abr.enabled', true);
      setAuto(true);
    }
  };

  const active = variants.find((t) => t.active);
  const state = unsupported
    ? 'Shaka · unsupported in this browser'
    : `Shaka${version ? ` ${version}` : ''} · DASH${variants.length ? ` · ${variants.length} variants` : ''}`;

  return (
    <main className="shell">
      <p className="eyebrow">Playback bench · Shaka</p>
      <h1 className="display" data-testid="dash-heading">
        DASH
      </h1>
      <p className="lede">
        One multi-rendition manifest through Shaka Player. Pin a variant to
        force a <code>quality_change</code>; hand control back to ABR and
        watch it pick one itself.
      </p>

      <PlayerBench
        title="Big Buck Bunny"
        state={state}
        note="Third-party DASH test manifest — override NEXT_PUBLIC_DEMO_DASH_URL if it has gone away."
        testid="dash"
        videoRef={ref}
        extraControls={
          variants.length > 0 ? (
            <div className="btn-row" data-testid="dash-variants">
              <span className="player-bench-label">Variant</span>
              <button type="button" className="chip" aria-pressed={auto} onClick={() => pickVariant(null)}>
                Auto{auto && active ? ` (${active.height}p)` : ''}
              </button>
              {variants.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="chip"
                  aria-pressed={!auto && t.active}
                  onClick={() => pickVariant(t)}
                >
                  {fmtVariant(t)}
                </button>
              ))}
            </div>
          ) : null
        }
      >
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- third-party test stream */}
        <video ref={ref} controls muted playsInline width={640} height={360} data-testid="dash-video" />
      </PlayerBench>
    </main>
  );
}
