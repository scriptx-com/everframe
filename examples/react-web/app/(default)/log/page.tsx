// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Field log — the interactive-list page. Add/confirm/delete feed click
// breadcrumbs and DOM mutations into the replay recorder; entries persist in
// localStorage (read from an effect, never during render — SSR must stay
// hydration-stable).
"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { SPECIMENS, getSpecimen } from "../../lib/specimens";
import { readLog, writeLog, type LogEntry } from "../../lib/field-log";

export default function FieldLogPage() {
  // Render the SSR pass with no entries; hydrate the real list from storage.
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [note, setNote] = useState("");
  const [specimenId, setSpecimenId] = useState("");

  useEffect(() => {
    setEntries(readLog());
  }, []);

  const update = (next: LogEntry[]) => {
    setEntries(next);
    writeLog(next);
  };

  const addEntry = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = note.trim();
    if (!trimmed || !entries) return;
    update([
      {
        id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        note: trimmed,
        specimenId: specimenId || undefined,
        site: "Added from field log",
        confirmed: false,
      },
      ...entries,
    ]);
    setNote("");
    setSpecimenId("");
  };

  const toggle = (id: string) => {
    if (!entries) return;
    update(entries.map((x) => (x.id === id ? { ...x, confirmed: !x.confirmed } : x)));
  };

  const remove = (id: string) => {
    if (!entries) return;
    update(entries.filter((x) => x.id !== id));
  };

  return (
    <main className="shell">
      <p className="eyebrow">Observations {entries ? `· ${entries.length} entries` : ""}</p>
      <h1 className="display">Field log</h1>
      <p className="lede">
        What you saw, where. Confirm a sighting once you&apos;ve matched it to a
        plate, or strike it from the record. Every button here lands in the
        report&apos;s breadcrumb trail.
      </p>

      <form className="log-form" onSubmit={addEntry}>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What did you see?"
          aria-label="Observation note"
          data-testid="log-input"
        />
        <select
          value={specimenId}
          onChange={(e) => setSpecimenId(e.target.value)}
          aria-label="Match to a specimen"
          data-testid="log-specimen-select"
        >
          <option value="">Unidentified</option>
          {SPECIMENS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.commonName}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-primary" data-testid="log-add">
          Add entry
        </button>
      </form>

      {entries === null ? (
        <p className="muted">Loading your log…</p>
      ) : entries.length === 0 ? (
        <div className="empty-state" data-testid="log-empty">
          <p style={{ margin: "0 0 12px" }}>
            The log is empty. Add an observation above, or log one straight
            from a specimen plate.
          </p>
          <Link href="/specimens" className="btn">
            Browse the catalog
          </Link>
        </div>
      ) : (
        <ul className="log-list" data-testid="log-list">
          {entries.map((entry) => {
            const specimen = entry.specimenId ? getSpecimen(entry.specimenId) : undefined;
            return (
              <li key={entry.id} className={entry.confirmed ? "confirmed" : undefined}>
                <input
                  type="checkbox"
                  checked={entry.confirmed}
                  onChange={() => toggle(entry.id)}
                  aria-label={`Confirm: ${entry.note}`}
                />
                <span className="log-note">
                  {entry.note}
                  {specimen ? (
                    <>
                      {" "}
                      <Link href={`/specimens/${specimen.id}`} className="mono-note">
                        [{specimen.id.toUpperCase()}]
                      </Link>
                    </>
                  ) : null}
                </span>
                <span className="log-meta">{entry.site}</span>
                <button
                  className="btn btn-small btn-danger"
                  onClick={() => remove(entry.id)}
                  aria-label={`Delete: ${entry.note}`}
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
