// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Settings — the SDK-surface page: setUser / setExtra / kill wired to real
// controls, so the example demonstrates the full useTraceItX() API, not just
// open().
"use client";
import { useState } from "react";
import { useTraceItX } from "@traceitx/react";

export default function SettingsPage() {
  const { setUser, setExtra, kill } = useTraceItX();
  const [name, setName] = useState("Ada Collector");
  const [email, setEmail] = useState("ada@example.com");
  const [extra, setExtra_] = useState('{"plan":"field-team","build":"demo"}');
  const [status, setStatus] = useState<string | null>(null);
  const [killed, setKilled] = useState(false);

  const applyUser = () => {
    setUser({ displayName: name, email });
    setStatus(`setUser applied — the next report is attributed to ${name}.`);
  };

  const applyExtra = () => {
    setExtra(extra);
    setStatus("setExtra applied — the string rides along with the next report.");
  };

  const killSdk = () => {
    kill();
    setKilled(true);
    setStatus(
      "SDK killed. Reporter, hotkey, and capture are disabled until the page reloads."
    );
  };

  return (
    <main className="shell">
      <p className="eyebrow">SDK surface</p>
      <h1 className="display">Settings</h1>
      <p className="lede">
        The reporter is one call; this page wires up the rest of the
        useTraceItX() API so you can watch each one land in the next report.
      </p>

      {status ? (
        <p className="fixture-note" role="status" data-testid="settings-status">
          {status}
        </p>
      ) : null}

      <section className="card">
        <h2 className="section-title">Identity — setUser()</h2>
        <p className="muted">
          Attribute reports to a signed-in user. Email-shaped values are still
          subject to redaction rules on the ingest side.
        </p>
        <div className="field-row">
          <div className="field">
            <label htmlFor="user-name">Name</label>
            <input
              id="user-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="user-name"
            />
          </div>
          <div className="field">
            <label htmlFor="user-email">Email</label>
            <input
              id="user-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="user-email"
            />
          </div>
        </div>
        <button className="btn btn-primary" onClick={applyUser} data-testid="apply-user">
          Apply setUser
        </button>
      </section>

      <section className="card">
        <h2 className="section-title">Report metadata — setExtra()</h2>
        <p className="muted">
          One opaque string, attached verbatim to the next report envelope.
          JSON is a convention, not a requirement.
        </p>
        <div className="field">
          <label htmlFor="extra-input">Extra payload</label>
          <textarea
            id="extra-input"
            rows={3}
            value={extra}
            onChange={(e) => setExtra_(e.target.value)}
            data-testid="extra-input"
          />
        </div>
        <button className="btn btn-primary" onClick={applyExtra} data-testid="apply-extra">
          Apply setExtra
        </button>
      </section>

      <section className="card">
        <h2 className="section-title">Triggers</h2>
        <p className="muted">
          This app installs two: the floating report button in the corner
          (host-owned — the SDK ships no visible chrome) and the built-in
          hotkey <strong>Cmd/Ctrl + Shift + B</strong>. Try the hotkey from any
          page.
        </p>
      </section>

      <section className="card">
        <h2 className="section-title">Kill switch — kill()</h2>
        <p className="muted">
          Permanently disables the SDK for this page load: recorder stops,
          triggers stop responding, nothing else is captured or sent. Reload
          to bring it back.
        </p>
        <button
          className="btn btn-danger"
          onClick={killSdk}
          disabled={killed}
          data-testid="kill-sdk"
        >
          {killed ? "SDK is killed for this session" : "Kill the SDK"}
        </button>
      </section>
    </main>
  );
}
