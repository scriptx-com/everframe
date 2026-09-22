// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phone-companion pairing QR for the web example. Mirrors
// examples/react-tv-sample/src/App.tsx: start the companion relay connection,
// render `companion.pairUrl` as a QR while unpaired, and show a state-driven
// indicator once a phone bonds.
//
// QR rendering is a HOST choice (the SDK ships zero QR chrome) — we use
// `qrcode.react`, same as the TV sample.
//
// Visibility is gated on `state`, NOT on `pairUrl`: as of sdk-react 0.4.3 the
// pair URL is retained after bond (cleared only on socket close), so the QR
// must be torn down off `state === 'paired'` — keying it off a null pairUrl
// would leave a stale QR on screen.
"use client";
import { useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import { companion } from "@traceitx/react";

export function CompanionQR() {
  const { state, pairUrl, resolvedName } = companion.useCompanion();

  useEffect(() => {
    // Opens the relay WS (idempotent). Requires the ingest service running and
    // the SDK built against it (TRACEITX_INGEST_URL). Until it connects, state
    // stays 'unpaired' with a null pairUrl → "Connecting to relay…".
    companion.start();
    return () => companion.stop();
  }, []);

  return (
    <section data-testid="companion-section">
      <h2 className="section-title">Phone-companion reporter</h2>
      <p className="muted">
        Scan the code to pair a phone and file this page&apos;s report from it —
        the relay streams context from this tab to the phone reporter.
      </p>

      {state === "unpaired" && pairUrl ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
          <div style={{ background: "#fff", padding: 12, borderRadius: 8, border: "1px solid #d8dacc" }}>
            <QRCodeSVG value={pairUrl} size={200} level="M" />
          </div>
          <p style={{ margin: 0 }}>Scan with your phone to file a report</p>
          <code
            data-testid="companion-pair-url"
            className="mono-note"
            style={{ wordBreak: "break-all" }}
          >
            {pairUrl}
          </code>
          {resolvedName ? (
            <p data-testid="companion-resolved-name" className="mono-note" style={{ margin: 0 }}>
              {resolvedName}
            </p>
          ) : null}
        </div>
      ) : null}

      {state === "unpaired" && !pairUrl ? (
        <p data-testid="companion-status">Connecting to relay…</p>
      ) : null}

      {state === "paired" ? (
        <p data-testid="companion-status">Phone connected — file your report from your phone.</p>
      ) : null}

      {state === "report_in_progress" ? (
        <p data-testid="companion-status">Report in progress on phone…</p>
      ) : null}

      {state === "phone_disconnected" ? (
        <p data-testid="companion-status">Phone disconnected — reconnecting…</p>
      ) : null}

      <p className="mono-note">State: {state}</p>
    </section>
  );
}
