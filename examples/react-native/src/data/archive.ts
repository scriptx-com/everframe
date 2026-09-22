// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Deterministic sighting-archive records — the RN mirror of the web
// example's /archive page. Generated from the row index only (no
// Math.random / Date.now at module scope) so every launch renders the
// identical list; the point is a long, scrollable SectionList for replay
// and screenshot capture to chew on.

import { SPECIMENS } from './specimens';

const SITES = [
  'Neris riverbank',
  'Verkiai oak grove',
  'Pavilniai ravine',
  'Bernardinai garden',
  'Labanoras bog edge',
  'Curonian Spit dune heath',
  'Aukštaitija lakeshore',
  'Užupis balcony',
] as const;

const OBSERVERS = ['A.M.', 'E.K.', 'R.B.', 'J.S.', 'V.P.'] as const;

const WEATHER = [
  'clear, light wind',
  'overcast',
  'after rain',
  'warm dusk',
  'morning dew',
  'hot, still air',
] as const;

/** Months rendered top-down, most recent first. [label, entries] */
const MONTHS: Array<[string, number]> = [
  ['July 2026', 9],
  ['June 2026', 18],
  ['May 2026', 15],
  ['April 2026', 11],
  ['March 2026', 7],
  ['October 2025', 6],
  ['September 2025', 12],
  ['August 2025', 16],
  ['July 2025', 17],
  ['June 2025', 14],
  ['May 2025', 10],
  ['April 2025', 5],
];

export interface ArchiveRecord {
  id: string;
  dayLabel: string;
  specimenIdx: number;
  site: string;
  observer: string;
  weather: string;
  count: number;
}

export interface ArchiveMonth {
  title: string;
  data: ArchiveRecord[];
}

export const ARCHIVE: ArchiveMonth[] = (() => {
  let globalIdx = 0;
  return MONTHS.map(([month, entryCount]) => {
    const monthAbbr = month.split(' ')[0].slice(0, 3);
    const data = Array.from({ length: entryCount }, () => {
      const idx = globalIdx++;
      const day = 28 - Math.floor(((idx * 31) % 100) / 4);
      const h = (idx * 7919 + 13) % 104729;
      return {
        id: `rec-${idx}`,
        day,
        dayLabel: `${monthAbbr} ${day}`,
        specimenIdx: h % SPECIMENS.length,
        site: SITES[h % SITES.length],
        observer: OBSERVERS[h % OBSERVERS.length],
        weather: WEATHER[h % WEATHER.length],
        count: 1 + (h % 6),
      };
    })
      .sort((a, b) => b.day - a.day)
      .map(({ day: _day, ...rest }) => rest);
    return { title: month, data };
  });
})();

export const ARCHIVE_TOTAL = ARCHIVE.reduce((sum, m) => sum + m.data.length, 0);
