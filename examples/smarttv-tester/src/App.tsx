// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Smart-TV tester shell: focus grid + key log + device info, plus the
// Everframe companion QR behind a tile. Back closes the overlay when open,
// otherwise attempts a platform exit (Tizen application API / window.close).
import * as React from 'react';
import { useCallback, useState } from 'react';
import { FocusProvider, useFocusable } from './focus/FocusManager.js';
import { DeviceInfo } from './components/DeviceInfo.js';
import { KeyLog } from './components/KeyLog.js';
import { TileGrid } from './components/TileGrid.js';
import { CompanionPane } from './components/CompanionPane.js';
import { CompanionControls } from './components/CompanionControls.js';
import { useCompanionConnection } from './companion/useCompanionConnection.js';

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

function PairTile({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const { ref, focused } = useFocusable({ id: 'pair-tile', onSelect: onOpen });
  return (
    <div
      ref={ref}
      style={{
        display: 'inline-block',
        marginTop: 8,
        padding: '14px 32px',
        fontSize: 20,
        borderRadius: 8,
        background: '#3a2a5e',
        border: focused ? '4px solid #7ab8ff' : '4px solid transparent',
      }}
    >
      Pair phone (Everframe QR)
    </div>
  );
}

export function App(): React.JSX.Element {
  const [showCompanion, setShowCompanion] = useState(false);
  const connection = useCompanionConnection();

  const openPairOverlay = useCallback(() => {
    connection.connect(); // no-op when already connected
    setShowCompanion(true);
  }, [connection]);

  const handleBack = useCallback(() => {
    // setState-with-updater doubles as a read: close the overlay if it is
    // open, exit the app otherwise — no ref bookkeeping needed.
    setShowCompanion((open) => {
      if (!open) exitApp();
      return false;
    });
  }, []);

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
            <CompanionControls connection={connection} />
            <KeyLog />
          </aside>
          <main style={{ flex: 1 }}>
            <TileGrid />
            <PairTile onOpen={openPairOverlay} />
          </main>
        </div>
        <p style={{ fontSize: 15, opacity: 0.45, margin: '16px 0 0' }}>
          Arrows: move focus · OK/Enter: select · Back/Escape: close overlay or exit
        </p>
        {showCompanion && (
          <CompanionPane connection={connection} onClose={() => setShowCompanion(false)} />
        )}
      </div>
    </FocusProvider>
  );
}
