// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Home ("Field desk") — the e2e anchor page. These fixtures MUST survive any
// redesign (packages/sdk-react/e2e/* assert them):
//   - data-testid="home-heading" with the literal SSR text
//     "Everframe Web SDK Example" (ssr-fixture.spec.ts)
//   - the component name `Home` (ui-tree-noise-filter.spec.ts)
//   - data-testid="cc-number" / "bearer-token" with the canonical PII strings
//     (seeded-pii.spec.ts), plus the Sensitive block and password input
//   - the companion section testids (CompanionQR)
"use client";
import Link from "next/link";
import { useEverframe, Sensitive } from "@everframe/react";
import { CompanionQR } from "./CompanionQR";
import { SpecimenPlate } from "../components/SpecimenPlate";
import { getSpecimen } from "../lib/specimens";

const HERO_SPECIMEN = getSpecimen("everframe-008")!; // stag beetle

export default function Home() {
  const { open } = useEverframe();

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow" data-testid="home-heading">
            Everframe Web SDK Example
          </p>
          <h1 className="display">
            A field catalog built to be broken
          </h1>
          <p className="lede">
            Elytra is a small insect field guide that exists so the Everframe
            reporter has something real to capture: pages to navigate, lists to
            mutate, images to screenshot, and seeded PII to redact. Wander
            around, then file a bug about a bug — the report button floats in
            the corner of every page, or press Cmd/Ctrl+Shift+B.
          </p>
          <div className="btn-row">
            <Link href="/specimens" className="btn btn-primary">
              Browse the specimens
            </Link>
            <button
              className="btn"
              data-testid="open-via-hook"
              onClick={() => open()}
            >
              Open reporter via useEverframe().open()
            </button>
          </div>
        </div>
        <div className="hero-plate">
          <SpecimenPlate specimen={HERO_SPECIMEN} />
        </div>
      </section>

      <section className="feature-cards" aria-label="What each page exercises">
        <Link href="/specimens">
          <div className="card">
            <h3>Specimens</h3>
            <p>
              An illustrated catalog with filters and detail pages — navigation
              breadcrumbs and image capture across routes.
            </p>
          </div>
        </Link>
        <Link href="/log">
          <div className="card">
            <h3>Field log</h3>
            <p>
              An interactive observation list — add, confirm, and delete
              entries to feed click breadcrumbs and DOM mutations into replay.
            </p>
          </div>
        </Link>
        <Link href="/archive">
          <div className="card">
            <h3>Archive</h3>
            <p>
              A year of sighting records in one long page — deep scrolling,
              sticky month headers, and a back-to-top jump for replay to
              capture.
            </p>
          </div>
        </Link>
        <Link href="/settings">
          <div className="card">
            <h3>Settings</h3>
            <p>
              The SDK surface beyond open(): setUser, setExtra, the hotkey,
              and the kill switch — wired to real controls.
            </p>
          </div>
        </Link>
      </section>

      <section className="card profile-card">
        <span className="fixture-note">
          fixture · seeded PII — every value below must be redacted from the
          report envelope
        </span>
        <h2 className="section-title">Collector profile</h2>
        <p className="muted">
          A pretend membership card. The reporter captures this page; the
          sdk-core redaction engine must scrub these values before the
          envelope leaves the browser.
        </p>
        <dl className="facts">
          <div>
            <dt>Card on file</dt>
            <dd className="pii-value" data-testid="cc-number">
              Test card: 4111-1111-1111-1111
            </dd>
          </div>
          <div>
            <dt>Session token</dt>
            <dd className="pii-value" data-testid="bearer-token">
              Auth: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fake-signature
            </dd>
          </div>
        </dl>
        <Sensitive>
          <p data-testid="sensitive-block">
            User-provided sensitive content (rendered behind &lt;Sensitive&gt;)
          </p>
        </Sensitive>
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="member-password">Member password (input type=password)</label>
          <input
            id="member-password"
            data-testid="password-input"
            type="password"
            defaultValue="hunter2"
          />
        </div>
      </section>

      <section className="card">
        <span className="fixture-note">
          fixture · phone-companion relay pairing
        </span>
        <CompanionQR />
      </section>

      <footer className="site-footer">
        <span>Elytra — the @everframe/react example app</span>
        <Link href="/strict-csp">Strict-CSP fixture</Link>
        <a href="https://everframe.dev" rel="noreferrer" target="_blank">
          everframe.dev
        </a>
      </footer>
    </main>
  );
}
