// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Playback bench — native progressive. A plain <video> over the local clip,
// no library, no integration: the vitals adapter binds to the element alone
// and every event in the timeline comes from HTMLMediaElement itself.
'use client';
import { useRef } from 'react';
import { useTrackPlayer } from '@everframe/react';
import { PlayerBench } from '../../../components/PlayerBench';
import { CLIP_SOURCES } from '../../../lib/media';

export default function NativePlaybackPage() {
  const ref = useRef<HTMLVideoElement>(null);
  useTrackPlayer(ref, { name: 'native' });

  return (
    <main className="shell">
      <p className="eyebrow">Playback bench · native</p>
      <h1 className="display" data-testid="native-heading">
        Native progressive
      </h1>
      <p className="lede">
        The baseline. Same-origin, two encodings, nothing between the element
        and the browser's own decoder — so whatever shows up in the session
        timeline is the adapter reading the element directly.
      </p>

      <PlayerBench
        title="Field loop"
        state="native · progressive · webm + mp4"
        note="Four seconds, deliberately NOT looping: a loop wrap is a real seek to the browser, and would stamp a seek + buffer pair into the timeline every four seconds."
        testid="native"
        videoRef={ref}
      >
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- silent colour loop, no speech */}
        <video ref={ref} controls muted playsInline width={640} height={360} data-testid="native-video">
          {CLIP_SOURCES.map((s) => (
            <source key={s.src} src={s.src} type={s.type} />
          ))}
        </video>
      </PlayerBench>
    </main>
  );
}
