// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Specimen detail — dynamic route. Exercises deep-link navigation, a large
// image capture target, a <Sensitive> region, and a cross-page write (log
// an observation → /log via localStorage).
"use client";
import { use, useState } from "react";
import Link from "next/link";
import { Sensitive } from "@everframe/react";
import { getSpecimen } from "../../../lib/specimens";
import { SpecimenPlate } from "../../../components/SpecimenPlate";
import { appendLog } from "../../../lib/field-log";

export default function SpecimenDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const specimen = getSpecimen(id);
  const [logged, setLogged] = useState(false);

  if (!specimen) {
    return (
      <main className="shell">
        <p className="eyebrow">Catalog</p>
        <h1 className="display">Plate not found</h1>
        <p className="lede">
          No specimen is filed under “{id}”. It may have flown off — the
          catalog only goes to TXX-008.
        </p>
        <Link href="/specimens" className="btn btn-primary">
          Back to the catalog
        </Link>
      </main>
    );
  }

  const logObservation = () => {
    appendLog({
      id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      note: `Observed: ${specimen.commonName} (${specimen.latinName})`,
      specimenId: specimen.id,
      site: "Logged from plate",
      confirmed: false,
    });
    setLogged(true);
  };

  return (
    <main className="shell">
      <p className="eyebrow">
        <Link href="/specimens">Catalog</Link> · {specimen.id.toUpperCase()}
      </p>
      <div className="detail-grid">
        <div>
          <SpecimenPlate specimen={specimen} />
        </div>
        <div>
          <h1 className="display" data-testid="specimen-heading">
            {specimen.commonName}
          </h1>
          <p className="lede" style={{ fontStyle: "italic", marginBottom: 8 }}>
            {specimen.latinName}
          </p>
          <span className="taxon-tag">{specimen.order}</span>

          <dl className="facts">
            <div>
              <dt>Size</dt>
              <dd>{specimen.sizeMm}</dd>
            </div>
            <div>
              <dt>Habitat</dt>
              <dd>{specimen.habitat}</dd>
            </div>
            <div>
              <dt>Season</dt>
              <dd>{specimen.season}</dd>
            </div>
          </dl>

          <p>{specimen.note}</p>

          <Sensitive>
            <p className="mono-note" data-testid="collector-notes">
              Collector’s private note: exact sighting coordinates withheld —
              this block is wrapped in &lt;Sensitive&gt; and must be masked in
              captures.
            </p>
          </Sensitive>

          <div className="btn-row" style={{ marginTop: 18 }}>
            <button
              className="btn btn-primary"
              onClick={logObservation}
              data-testid="log-observation"
            >
              {logged ? "Logged — add another" : "Log an observation"}
            </button>
            <Link href="/log" className="btn">
              Open field log
            </Link>
          </div>
          {logged ? (
            <p className="mono-note" style={{ marginTop: 10 }} role="status">
              Saved to your field log.
            </p>
          ) : null}
        </div>
      </div>
    </main>
  );
}
