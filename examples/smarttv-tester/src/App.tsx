// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Smart-TV tester shell: focus grid + key log + device info. Back attempts a
// platform exit (Tizen application API / window.close).
import * as React from 'react';
import { useCallback } from 'react';
import { FocusProvider } from './focus/FocusManager.js';
import { DeviceInfo } from './components/DeviceInfo.js';
import { KeyLog } from './components/KeyLog.js';
import { TileGrid } from './components/TileGrid.js';

function exitApp(): void {
  const w = window as unknown as {
    tizen?: { application: { getCurrentApplication(): { exit(): void } } };
  };
  try {
    if (w.tizen) {
      w.tizen.application.getCurrentApplication().exit();
      return;
    }
  } catch {
    // fall through to window.close
  }
  window.close();
}

export function App(): React.JSX.Element {
  const handleBack = useCallback(() => exitApp(), []);

  return (
    <FocusProvider onBack={handleBack}>
      <div
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: 32,
          boxSizing: 'border-box',
        }}
      >
        <h1 style={{ fontSize: 34, margin: '0 0 20px' }}>Everframe — Smart-TV Tester</h1>
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <aside style={{ width: 380, marginRight: 40 }}>
            <DeviceInfo />
            <KeyLog />
          </aside>
          <main style={{ flex: 1 }}>
            <TileGrid />
          </main>
        </div>
        <p style={{ fontSize: 15, opacity: 0.45, margin: '16px 0 0' }}>
          Arrows: move focus · OK/Enter: select · Back/Escape: exit
        </p>
      </div>
    </FocusProvider>
  );
}
