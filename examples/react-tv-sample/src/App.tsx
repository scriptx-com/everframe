// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-09 Task 2 — Tizen/WebOS smart-TV companion-mode sample.
//
// Demonstrates the host-rendering contract for the React-TV companion:
//   1. Init: createCompanion() + createRelayWSClient({ endpoint, companion, ... })
//   2. Render a QR for `companion.pairUrl` while state === 'unpaired'.
//   3. Render a state-driven indicator when paired / report-in-progress.
//
// QR rendering uses `qrcode.react` — a CHOICE BY THE HOST, not the SDK
// (Phase 05.1 precedent: SDK ships zero QR chrome, mirroring the
// triggers-are-host-concern lock in MEMORY.md). Any QR lib works; we picked
// qrcode.react for its tiny footprint + tree-shakeable SVG export.
import * as React from "react";
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { companion } from "@everframe/react";

type CompanionState = companion.CompanionState;

// Relay endpoint is baked into the @everframe/react build at compile time
// (Release bundle: https://everframe.dev; Dev bundle: EVERFRAME_INGEST_URL
// build env). For local dev, set `globalThis.__EVERFRAME_DEV_INGEST_URL__`
// in this app's bootstrap before <App /> mounts.

export function App(): React.JSX.Element {
  const [state, setState] = useState<CompanionState>("unpaired");
  const [pairUrl, setPairUrl] = useState<string | null>(null);

  useEffect(() => {
    const c = companion.createCompanion();
    const ws = companion.createRelayWSClient({
      companion: c,
      onReportRequest: (correlationId) => {
        // Sample apps don't ship a real capture — wire the bridge in your
        // own app via companion.handleReportRequest(correlationId, ws, { ... }).
        void companion.handleReportRequest(correlationId, ws, {
          logs: 0,
          network: 0,
          uiTreeNodes: 0,
        });
      },
      onReportSubmit: (msg) => {
        void companion.handleReportSubmit(msg);
      },
    });
    const offState = c.onState((_old, next) => setState(next));
    const offPair = c.onPairUrl(setPairUrl);
    ws.start();

    return () => {
      offState();
      offPair();
      ws.stop();
    };
  }, []);

  return (
    <main
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "32px",
      }}
    >
      <h1 style={{ fontSize: 48, margin: 0 }}>Everframe — React TV Sample</h1>

      {state === "unpaired" && pairUrl && (
        <div style={{ background: "#fff", padding: 24, borderRadius: 12 }}>
          <QRCodeSVG value={pairUrl} size={400} level="M" />
        </div>
      )}
      {state === "unpaired" && !pairUrl && (
        <p style={{ fontSize: 24 }}>Connecting to relay…</p>
      )}
      {state === "paired" && (
        <p style={{ fontSize: 28 }}>
          Phone connected — file your report from your phone
        </p>
      )}
      {state === "report_in_progress" && (
        <p style={{ fontSize: 28 }}>Report in progress…</p>
      )}
      {state === "phone_disconnected" && (
        <p style={{ fontSize: 24, opacity: 0.7 }}>
          Phone disconnected — reconnecting…
        </p>
      )}

      <p
        style={{ position: "absolute", bottom: 24, fontSize: 16, opacity: 0.5 }}
      >
        State: {state}
      </p>
    </main>
  );
}
