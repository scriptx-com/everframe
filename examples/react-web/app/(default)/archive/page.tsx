// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Archive — the long-scroll page. ~140 sighting records grouped under sticky
// month headers, so session replay has real scroll depth, sticky positioning,
// and a scroll-to-top jump to capture. Records are generated DETERMINISTICALLY
// from the row index (no Math.random / Date.now at render) — SSR output must
// stay hydration-stable (asserted by ssr-fixture.spec.ts on the home page,
// but the whole app keeps the same rule).
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { SPECIMENS } from "../../lib/specimens";

const SITES = [
  "Neris riverbank",
  "Verkiai oak grove",
  "Pavilniai ravine",
  "Bernardinai garden",
  "Labanoras bog edge",
  "Curonian Spit dune heath",
  "Aukštaitija lakeshore",
  "Užupis balcony",
] as const;

const OBSERVERS = ["A.M.", "E.K.", "R.B.", "J.S.", "V.P."] as const;

const WEATHER = [
  "clear, light wind",
  "overcast",
  "after rain",
  "warm dusk",
  "morning dew",
  "hot, still air",
] as const;

/** Months rendered top-down, most recent first. [label, entries] */
const MONTHS: Array<[string, number]> = [
  ["July 2026", 9],
  ["June 2026", 18],
  ["May 2026", 15],
  ["April 2026", 11],
  ["March 2026", 7],
  ["October 2025", 6],
  ["September 2025", 12],
  ["August 2025", 16],
  ["July 2025", 17],
  ["June 2025", 14],
  ["May 2025", 10],
  ["April 2025", 5],
];

interface ArchiveRecord {
  id: string;
  day: number;
  specimenIdx: number;
  site: string;
  observer: string;
  weather: string;
  count: number;
}

/** Deterministic pseudo-shuffle: same output every render, server and client. */
function recordAt(globalIdx: number, day: number): ArchiveRecord {
  const h = (globalIdx * 7919 + 13) % 104729;
  return {
    id: `rec-${globalIdx}`,
    day,
    specimenIdx: h % SPECIMENS.length,
    site: SITES[h % SITES.length],
    observer: OBSERVERS[h % OBSERVERS.length],
    weather: WEATHER[h % WEATHER.length],
    count: 1 + (h % 6),
  };
}

const TOTAL = MONTHS.reduce((sum, [, n]) => sum + n, 0);

export default function ArchivePage() {
  const [showTop, setShowTop] = useState(false);

  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 600);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  let globalIdx = 0;

  return (
    <main className="shell">
      <p className="eyebrow">Records · {TOTAL} sightings · 12 months</p>
      <h1 className="display">Sighting archive</h1>
      <p className="lede">
        Every confirmed record from the last two field seasons, newest first.
        Scroll deep — this page exists so the replay recorder has a long
        document, sticky headers, and a scroll-to-top jump to chew on.
      </p>

      <div data-testid="archive-list">
        {MONTHS.map(([month, entryCount]) => {
          const rows = Array.from({ length: entryCount }, () => {
            // Descending days within the month, most recent first.
            const idx = globalIdx++;
            const day = 28 - Math.floor(((idx * 31) % 100) / 4);
            return recordAt(idx, day);
          }).sort((a, b) => b.day - a.day);
          return (
            <section key={month} aria-label={month}>
              <h2 className="archive-month">
                {month}
                <span className="archive-month-count">{entryCount} records</span>
              </h2>
              <ul className="archive-list">
                {rows.map((r) => {
                  const s = SPECIMENS[r.specimenIdx];
                  return (
                    <li key={r.id}>
                      <span className="archive-day">
                        {month.split(" ")[0].slice(0, 3)} {r.day}
                      </span>
                      <span className="archive-species">
                        <Link href={`/specimens/${s.id}`}>{s.commonName}</Link>
                        {r.count > 1 ? (
                          <span className="archive-count"> ×{r.count}</span>
                        ) : null}
                      </span>
                      <span className="archive-site">{r.site}</span>
                      <span className="archive-meta">
                        {r.weather} · {r.observer}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      <p className="mono-note" style={{ marginTop: 28 }}>
        End of archive — {TOTAL} records shown.
      </p>

      {showTop ? (
        <button
          type="button"
          className="btn back-to-top"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          data-testid="back-to-top"
        >
          ↑ Back to top
        </button>
      ) : null}
    </main>
  );
}
