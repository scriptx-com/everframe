// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe companion overlay — a pure view over the app-level companion
// connection (see src/companion/useCompanionConnection.ts): the pair QR
// while unpaired, a state indicator afterwards. QR rendering is the host's
// choice (qrcode.react here), never the SDK's.
import * as React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useFocusable } from '../focus/FocusManager.js';
import type { CompanionConnection } from '../companion/useCompanionConnection.js';

export function CompanionPane({
  connection,
  onClose,
}: {
  connection: CompanionConnection;
  onClose: () => void;
}): React.JSX.Element {
  const { status, pairUrl, code, error } = connection;
  const { ref, focused } = useFocusable({
    id: 'companion-close',
    onSelect: onClose,
    autoFocus: true,
  });

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(6, 6, 20, 0.94)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <h2 style={{ fontSize: 32, margin: '0 0 24px' }}>Pair your phone</h2>

      {error && <p style={{ fontSize: 20, color: '#ff9c9c' }}>Companion failed: {error}</p>}
      {!error && status === 'unpaired' && pairUrl && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ background: '#fff', padding: 20, borderRadius: 12 }}>
            <QRCodeSVG value={pairUrl} size={320} level="M" />
          </div>
          {code && (
            <p style={{ fontSize: 20, letterSpacing: 4, marginTop: 12 }}>
              Code: <strong>{code}</strong>
            </p>
          )}
        </div>
      )}
      {!error && (status === 'connecting' || (status === 'unpaired' && !pairUrl)) && (
        <p style={{ fontSize: 22 }}>Connecting to relay…</p>
      )}
      {status === 'disconnected' && !error && (
        <p style={{ fontSize: 22, opacity: 0.7 }}>Not connected — press Connect first</p>
      )}
      {status === 'paired' && (
        <p style={{ fontSize: 24 }}>Phone connected — file your report from your phone</p>
      )}
      {status === 'report_in_progress' && <p style={{ fontSize: 24 }}>Report in progress…</p>}
      {status === 'phone_disconnected' && (
        <p style={{ fontSize: 22, opacity: 0.7 }}>Phone disconnected — reconnecting…</p>
      )}

      <p style={{ fontSize: 16, opacity: 0.5, marginTop: 16 }}>State: {status}</p>

      <div
        ref={ref}
        style={{
          marginTop: 32,
          padding: '12px 40px',
          fontSize: 22,
          borderRadius: 8,
          background: '#1c1c3a',
          border: focused ? '4px solid #7ab8ff' : '4px solid transparent',
        }}
      >
        Close
      </div>
    </div>
  );
}
