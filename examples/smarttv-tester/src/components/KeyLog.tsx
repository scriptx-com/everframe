// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Rolling log of raw keydown events — the point of the tester on a real
// remote: see exactly which keyCodes the platform delivers (Tizen back is
// 10009, webOS back is 461, color keys vary by vendor...).
import * as React from 'react';
import { useEffect, useState } from 'react';

interface LoggedKey {
  seq: number;
  key: string;
  keyCode: number;
}

const MAX_ROWS = 8;

export function KeyLog(): React.JSX.Element {
  const [rows, setRows] = useState<LoggedKey[]>([]);

  useEffect(() => {
    let seq = 0;
    const onKeyDown = (e: KeyboardEvent) => {
      seq += 1;
      const entry: LoggedKey = { seq, key: e.key || '(none)', keyCode: e.keyCode };
      setRows((prev) => [entry, ...prev].slice(0, MAX_ROWS));
    };
    // Capture phase so the focus manager's preventDefault never hides a key.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>Key events</h2>
      {rows.length === 0 && (
        <p style={{ fontSize: 16, opacity: 0.5 }}>Press any remote key…</p>
      )}
      {rows.map((r) => (
        <div
          key={r.seq}
          style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, lineHeight: '24px' }}
        >
          <span>{r.key}</span>
          <span style={{ opacity: 0.6 }}>keyCode {r.keyCode}</span>
        </div>
      ))}
    </section>
  );
}
