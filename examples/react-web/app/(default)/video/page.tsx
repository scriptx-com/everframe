// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Motion plates — the <video> torture bench for the screenshot pipeline.
//
// WHY THIS PAGE EXISTS: a `<video>` element is the single most hostile thing a
// DOM-cloning screenshot library can meet, and the failure is a HANG rather
// than a throw, so it slips past every try/catch. The four plates below are
// not decoration — each one is a distinct, independently-reachable state that
// broke capture in a different way. Keep all four.
//
//   1. Healthy      readyState 4, same-origin. The happy path, and the only
//                   plate whose real pixels can reach the screenshot.
//   2. Stalled      readyState 0 forever — the response never completes, so
//                   neither `loadeddata` nor `error` ever fires.
//   3. Cross-origin readyState 4, but drawing it onto a canvas TAINTS that
//                   canvas, so reading the frame back throws SecurityError.
//   4. Bare         No `src` at all. Looks trivial; was the worst of the four.
//
// Plate 4 deserves its own note. Seeking a media element whose readyState is
// HAVE_NOTHING is spec'd to set the default playback start position and
// RETURN — no `seeking`, no `seeked`, ever. Any capture path that assigns
// `currentTime` and then awaits `seeked` therefore waits for an event that is
// never coming. A `<video>` with no source is extremely ordinary (a player
// that has not been handed a stream yet, a lazily-initialised one, a hidden
// preload slot), which is what made this so much worse than it looks.
'use client';
import { useEffect, useState } from 'react';
import { CLIP_SOURCES } from '../../lib/media';

/**
 * An origin prefix pointing at the SAME server over a DIFFERENT ORIGIN, built
 * by swapping the hostname between its two loopback spellings.
 *
 * `localhost` and `127.0.0.1` are distinct origins to the same-origin policy
 * even when they resolve to the same socket, so this taints a canvas exactly
 * like a real CDN would — without the example app needing a second server, a
 * fixed port, or network access. Next serves `public/` with no
 * `Access-Control-Allow-Origin`, which is precisely the condition we want.
 *
 * Returns null during SSR and on any non-loopback host (someone browsing the
 * demo over a LAN address), where the swap would not be meaningful.
 */
function useCrossOriginBase(): string | null {
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    const { hostname, protocol, port } = window.location;
    const swapped =
      hostname === 'localhost' ? '127.0.0.1' : hostname === '127.0.0.1' ? 'localhost' : null;
    if (!swapped) return;
    setBase(`${protocol}//${swapped}${port ? `:${port}` : ''}`);
  }, []);
  return base;
}

interface PlateProps {
  title: string;
  state: string;
  note: string;
  testid: string;
  children: React.ReactNode;
}

function Plate({ title, state, note, testid, children }: PlateProps) {
  return (
    <figure className="video-plate" data-testid={`${testid}-plate`}>
      <div className="video-frame">{children}</div>
      <figcaption>
        <p className="common-name">{title}</p>
        <p className="latin">{state}</p>
        <p className="plate-note">{note}</p>
      </figcaption>
    </figure>
  );
}

export default function VideoPage() {
  const crossOriginBase = useCrossOriginBase();

  return (
    <main className="shell">
      <p className="eyebrow">Motion plates · 4 states</p>
      <h1 className="display" data-testid="video-heading">
        Video
      </h1>
      <p className="lede">
        Four <code>&lt;video&gt;</code> elements in four different readiness
        states, plus an in-flow layout check. Open a report from this page —
        capture must complete promptly, show the live frame where one can be
        read, and leave the page's layout untouched.
      </p>

      <div className="video-grid" data-testid="video-grid">
        <Plate
          title="Healthy loop"
          state="readyState 4 · same-origin"
          note="Decodable and same-origin: its real frame reaches the screenshot."
          testid="video-healthy"
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- silent colour loop, no speech */}
          <video
            data-testid="video-healthy"
            autoPlay
            muted
            loop
            playsInline
            width={480}
            height={270}
          >
            {CLIP_SOURCES.map((s) => (
              <source key={s.src} src={s.src} type={s.type} />
            ))}
          </video>
        </Plate>

        <Plate
          title="Stalled source"
          state="readyState 0 · never settles"
          note="Response opens and never finishes — no loadeddata, no error. Falls back to a placeholder."
          testid="video-stalled"
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- never decodes; there is nothing to caption */}
          <video
            data-testid="video-stalled"
            src="/api/stalled-video"
            muted
            playsInline
            width={480}
            height={270}
          />
        </Plate>

        <Plate
          title="Cross-origin"
          state="readyState 4 · taints canvas"
          note="Plays fine, but reading its frame back throws SecurityError. Falls back to a placeholder."
          testid="video-crossorigin"
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- silent colour loop, no speech */}
          {crossOriginBase ? (
            <video
              data-testid="video-crossorigin"
              autoPlay
              muted
              loop
              playsInline
              width={480}
              height={270}
            >
              {CLIP_SOURCES.map((s) => (
                <source key={s.src} src={`${crossOriginBase}${s.src}`} type={s.type} />
              ))}
            </video>
          ) : (
            <p className="plate-note">
              Cross-origin plate needs a loopback host (localhost / 127.0.0.1).
            </p>
          )}
        </Plate>

        <Plate
          title="Bare element"
          state="readyState 0 · no source"
          note="No src at all. Assigning currentTime here never fires seeked — the original hang."
          testid="video-bare"
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- no source; there is nothing to caption */}
          <video data-testid="video-bare" muted playsInline width={480} height={270} />
        </Plate>
      </div>

      {/* --------------------------------------------------------------
          Layout fidelity bench.

          Every plate above sits in a CSS-sized box (`aspect-ratio`), so its
          container holds the space open whatever happens to the video — which
          means those plates CANNOT detect a collapsed video box. This section
          deliberately does the opposite: an in-flow `<video>` whose own
          intrinsic size is the only thing reserving the space, with a marker
          band immediately beneath it.

          Drop the video from the capture without standing something in for it
          and the marker moves up by exactly the video's height (measured:
          180px). `video-capture.spec.ts` asserts the marker lands in the
          screenshot where the live page puts it.
          -------------------------------------------------------------- */}
      <section className="flow-bench" data-testid="flow-bench">
        <h2 className="flow-bench-title">Layout fidelity</h2>
        <p className="plate-note">
          An in-flow video with nothing else reserving its space. The bar below
          must sit at the same height in the screenshot as it does here.
        </p>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- silent colour loop, no speech */}
        <video
          data-testid="video-inflow"
          autoPlay
          muted
          loop
          playsInline
          width={480}
          height={270}
          className="flow-bench-video"
        >
          {CLIP_SOURCES.map((s) => (
            <source key={s.src} src={s.src} type={s.type} />
          ))}
        </video>
        <p className="flow-bench-marker" data-testid="flow-marker">
          Marker band
        </p>
      </section>
    </main>
  );
}
