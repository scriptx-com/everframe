// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The control strip under every `/playback/*` player.
//
// Owns the CONTROLS, not the player: each page keeps its own <video>, ref and
// tracking hook (the integration differs per page — hls.js, Shaka, none) and
// passes the ref in. Everything here drives the HTMLMediaElement directly, so
// the same strip exercises the vitals adapter identically whatever library
// sits behind the element: play/pause → `play`/`pause`, the seek buttons and
// scrub bar → `seek` plus the `buffer_start`/`buffer_end` pair a real seek
// produces, the rate select → `rate_change`. Library-specific controls
// (level/variant pickers) come in through `extraControls`.
//
// Tracking is automatic — attached by the page's `useTrackPlayer` on mount.
// There is deliberately no "track"/"detach" button: the bench exists to show
// what a customer gets by having a player on the page, not to make them work
// for it.
'use client';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';

interface PlayerBenchProps {
  title: string;
  /** Mono subtitle, e.g. "hls.js · VOD · 8 levels". */
  state: string;
  note: string;
  testid: string;
  videoRef: RefObject<HTMLMediaElement | null>;
  /** Library-specific controls (level/variant pickers), rendered below transport. */
  extraControls?: ReactNode;
  /** The <video> element itself. */
  children: ReactNode;
}

interface ElementState {
  currentTime: number;
  duration: number;
  seekStart: number;
  seekEnd: number;
  paused: boolean;
  buffering: boolean;
  readyState: number;
  bufferedAheadS: number;
  rate: number;
  muted: boolean;
}

const RATES = [0.5, 1, 1.5, 2] as const;

/** Events that can change anything the readout or scrub bar shows. */
const SYNC_EVENTS = [
  'loadedmetadata', 'durationchange', 'timeupdate', 'progress', 'play', 'pause',
  'playing', 'waiting', 'seeking', 'seeked', 'ratechange', 'volumechange',
  'emptied', 'ended',
] as const;

function bufferedAhead(el: HTMLMediaElement): number {
  const { buffered, currentTime } = el;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
      return buffered.end(i) - currentTime;
    }
  }
  return 0;
}

/**
 * The seekable window, which is the honest range for the scrub bar: a live
 * stream has `duration === Infinity`, so `[0, duration]` is useless there,
 * while `seekable` is the DVR window the player actually lets you enter.
 */
function seekableRange(el: HTMLMediaElement): [number, number] {
  if (el.seekable.length > 0) {
    return [el.seekable.start(0), el.seekable.end(el.seekable.length - 1)];
  }
  return [0, Number.isFinite(el.duration) ? el.duration : 0];
}

function readState(el: HTMLMediaElement, buffering: boolean): ElementState {
  const [seekStart, seekEnd] = seekableRange(el);
  return {
    currentTime: el.currentTime,
    duration: el.duration,
    seekStart,
    seekEnd,
    paused: el.paused,
    buffering,
    readyState: el.readyState,
    bufferedAheadS: bufferedAhead(el),
    rate: el.playbackRate,
    muted: el.muted,
  };
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return 'live';
  const total = Math.max(0, Math.floor(s));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function PlayerBench({
  title, state, note, testid, videoRef, extraControls, children,
}: PlayerBenchProps) {
  const [st, setSt] = useState<ElementState | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return undefined;
    // `waiting` → `playing` is the same pair the vitals adapter derives its
    // buffer spans from, so the readout's "buffering" flag lines up with what
    // lands in the session timeline.
    let buffering = false;
    const sync = (ev?: Event) => {
      if (ev?.type === 'waiting') buffering = true;
      else if (ev?.type === 'playing' || ev?.type === 'pause' || ev?.type === 'emptied') buffering = false;
      setSt(readState(el, buffering));
    };
    for (const name of SYNC_EVENTS) el.addEventListener(name, sync);
    sync();
    return () => {
      for (const name of SYNC_EVENTS) el.removeEventListener(name, sync);
    };
  }, [videoRef]);

  const el = () => videoRef.current;

  const seekTo = (t: number) => {
    const v = el();
    if (!v) return;
    const [lo, hi] = seekableRange(v);
    v.currentTime = Math.min(Math.max(t, lo), hi || t);
  };

  const scrubMin = st?.seekStart ?? 0;
  const scrubMax = st && st.seekEnd > scrubMin ? st.seekEnd : 0;

  return (
    <figure className="player-bench" data-testid={`${testid}-bench`}>
      <div className="player-bench-frame">{children}</div>
      <figcaption>
        <p className="common-name">{title}</p>
        <p className="latin">{state}</p>
        <p className="plate-note">{note}</p>
      </figcaption>

      <div className="player-bench-controls">
        <div className="btn-row">
          <button type="button" className="btn btn-primary btn-small" data-testid={`${testid}-play`}
            onClick={() => { el()?.play().catch(() => undefined); }}>
            Play
          </button>
          <button type="button" className="btn btn-small" data-testid={`${testid}-pause`}
            onClick={() => el()?.pause()}>
            Pause
          </button>
          <button type="button" className="btn btn-small" data-testid={`${testid}-stop`}
            onClick={() => { const v = el(); if (!v) return; v.pause(); seekTo(seekableRange(v)[0]); }}>
            Stop
          </button>
          <span className="player-bench-sep" aria-hidden="true" />
          <button type="button" className="btn btn-small" data-testid={`${testid}-back`}
            onClick={() => { const v = el(); if (v) seekTo(v.currentTime - 10); }}>
            −10s
          </button>
          <button type="button" className="btn btn-small" data-testid={`${testid}-fwd`}
            onClick={() => { const v = el(); if (v) seekTo(v.currentTime + 10); }}>
            +10s
          </button>
          <span className="player-bench-sep" aria-hidden="true" />
          <label className="player-bench-rate">
            Rate
            <select
              data-testid={`${testid}-rate`}
              value={st?.rate ?? 1}
              onChange={(e) => { const v = el(); if (v) v.playbackRate = Number(e.target.value); }}
            >
              {RATES.map((r) => <option key={r} value={r}>{r}×</option>)}
            </select>
          </label>
          <button type="button" className="chip" aria-pressed={st?.muted ?? true} data-testid={`${testid}-mute`}
            onClick={() => { const v = el(); if (v) v.muted = !v.muted; }}>
            {st?.muted === false ? 'Sound on' : 'Muted'}
          </button>
        </div>

        <input
          type="range"
          className="player-bench-scrub"
          aria-label="Seek"
          data-testid={`${testid}-scrub`}
          min={scrubMin}
          max={scrubMax}
          step={0.1}
          value={Math.min(st?.currentTime ?? 0, scrubMax)}
          disabled={scrubMax <= scrubMin}
          onChange={(e) => seekTo(Number(e.target.value))}
        />

        <p className="player-bench-readout mono-note" data-testid={`${testid}-readout`}>
          {st ? (
            <>
              {fmtTime(st.currentTime)} / {fmtTime(st.duration)}
              {' · '}readyState {st.readyState}
              {' · '}{st.buffering ? 'buffering' : st.paused ? 'paused' : 'playing'}
              {' · '}buffered +{st.bufferedAheadS.toFixed(1)}s
            </>
          ) : 'no element'}
        </p>

        {extraControls ? <div className="player-bench-extra">{extraControls}</div> : null}
      </div>
    </figure>
  );
}
