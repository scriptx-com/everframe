// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Sidebar companion section: live connection status plus a focusable
// Connect/Disconnect toggle for the app-level relay session.
import * as React from 'react';
import { useFocusable } from '../focus/FocusManager.js';
import type { CompanionConnection } from '../companion/useCompanionConnection.js';

const STATUS_LABEL: Record<string, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  unpaired: 'Connected — waiting for phone',
  paired: 'Phone paired',
  report_in_progress: 'Report in progress',
  phone_disconnected: 'Phone disconnected',
};

export function CompanionControls({
  connection,
}: {
  connection: CompanionConnection;
}): React.JSX.Element {
  const { connected, status, code, error, discoverable, connect, disconnect } = connection;
  const { ref, focused } = useFocusable({
    id: 'companion-connect',
    onSelect: () => (connected ? disconnect() : connect()),
  });

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>Companion</h2>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, lineHeight: '28px' }}>
        <span style={{ opacity: 0.6 }}>Relay</span>
        <span style={{ color: connected ? '#8fd8a8' : '#f0f0f0' }}>
          {STATUS_LABEL[status] ?? status}
        </span>
      </div>
      {code && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, lineHeight: '28px' }}>
          <span style={{ opacity: 0.6 }}>Code</span>
          <span>{code}</span>
        </div>
      )}
      {error && <p style={{ fontSize: 15, color: '#ff9c9c', margin: '4px 0 0' }}>{error}</p>}
      {!discoverable && (
        <p style={{ fontSize: 14, color: '#ffcf8f', margin: '4px 0 0' }}>
          No SDK key baked — device won't appear on the dashboard. Set EVERFRAME_KEY_WEB in
          the repo-root .env and restart the dev server / rebuild.
        </p>
      )}
      <div
        ref={ref}
        style={{
          display: 'inline-block',
          marginTop: 10,
          padding: '10px 28px',
          fontSize: 18,
          borderRadius: 8,
          background: connected ? '#5e2a2a' : '#2a4a6e',
          border: focused ? '4px solid #7ab8ff' : '4px solid transparent',
        }}
      >
        {connected ? 'Disconnect companion' : 'Connect companion'}
      </div>
    </section>
  );
}
