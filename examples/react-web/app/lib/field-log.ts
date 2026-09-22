// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Tiny localStorage-backed store for the field log. Client-only; callers
// must read from effects/handlers (never during render) so SSR output stays
// hydration-stable.

export interface LogEntry {
  id: string;
  note: string;
  /** Specimen catalog id, when the entry was logged from a plate. */
  specimenId?: string;
  site: string;
  confirmed: boolean;
}

const KEY = "elytra-field-log";

/** Deterministic starter entries so the log page never opens empty. */
export const SEED_ENTRIES: LogEntry[] = [
  {
    id: "seed-1",
    note: "Two ladybirds on the office windowsill — the dogfood kind of bug.",
    specimenId: "txx-001",
    site: "Vilnius, office",
    confirmed: true,
  },
  {
    id: "seed-2",
    note: "Faint green glow by the path after dusk. Almost certainly Lampyris.",
    specimenId: "txx-005",
    site: "Neris riverbank",
    confirmed: false,
  },
  {
    id: "seed-3",
    note: "Something large buzzed past the balcony. Stag beetle? Log and verify.",
    site: "Užupis, balcony",
    confirmed: false,
  },
];

export function readLog(): LogEntry[] {
  if (typeof window === "undefined") return SEED_ENTRIES;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return SEED_ENTRIES;
    return JSON.parse(raw) as LogEntry[];
  } catch {
    return SEED_ENTRIES;
  }
}

export function writeLog(entries: LogEntry[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* storage full/blocked — the demo list still works in memory */
  }
}

export function appendLog(entry: LogEntry): void {
  writeLog([entry, ...readLog()]);
}
