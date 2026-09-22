// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Specimens — the catalog grid. Filter chips + card links exercise click
// breadcrumbs and client-side navigation; the SVG plates give the screenshot
// pipeline real imagery to capture.
"use client";
import { useState } from "react";
import Link from "next/link";
import { SPECIMENS, ORDERS } from "../../lib/specimens";
import { SpecimenPlate } from "../../components/SpecimenPlate";

export default function SpecimensPage() {
  const [order, setOrder] = useState<string | null>(null);
  const shown = order ? SPECIMENS.filter((s) => s.order === order) : SPECIMENS;

  return (
    <main className="shell">
      <p className="eyebrow">Catalog · {SPECIMENS.length} plates</p>
      <h1 className="display">Specimens</h1>
      <p className="lede">
        Eight residents of Baltic meadows and old oak woods, drawn as archival
        plates. Filter by order, open a plate for the field notes.
      </p>

      <div className="btn-row" style={{ marginBottom: 28 }} role="group" aria-label="Filter by order">
        <button
          className="chip"
          aria-pressed={order === null}
          onClick={() => setOrder(null)}
          data-testid="filter-all"
        >
          All orders
        </button>
        {ORDERS.map((o) => (
          <button
            key={o}
            className="chip"
            aria-pressed={order === o}
            onClick={() => setOrder(o)}
            data-testid={`filter-${o.toLowerCase()}`}
          >
            {o}
          </button>
        ))}
      </div>

      <div className="card-grid" data-testid="specimen-grid">
        {shown.map((s) => (
          <Link key={s.id} href={`/specimens/${s.id}`} className="specimen-card">
            <figure>
              <SpecimenPlate specimen={s} />
              <figcaption>
                <p className="common-name">{s.commonName}</p>
                <p className="latin">{s.latinName}</p>
                <span className="taxon-tag">{s.order}</span>
              </figcaption>
            </figure>
          </Link>
        ))}
      </div>
    </main>
  );
}
