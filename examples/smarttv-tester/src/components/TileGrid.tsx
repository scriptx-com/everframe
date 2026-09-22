// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The focus-manager exercise area: rows of focusable tiles. Selecting a
// tile toggles it, so both navigation (focus ring) and activation (Enter/OK)
// are visible at a glance. Layout is flexbox + margins on purpose — CSS grid
// and flex `gap` don't exist on the older TV engines this app targets.
import * as React from 'react';
import { useState } from 'react';
import { useFocusable } from '../focus/FocusManager.js';

function Tile({ label }: { label: string }): React.JSX.Element {
  const [active, setActive] = useState(false);
  const { ref, focused } = useFocusable({ onSelect: () => setActive((v) => !v) });

  return (
    <div
      ref={ref}
      style={{
        width: 150,
        height: 90,
        marginRight: 16,
        marginBottom: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 20,
        borderRadius: 8,
        background: active ? '#2f6f4f' : '#1c1c3a',
        border: focused ? '4px solid #7ab8ff' : '4px solid transparent',
        transition: 'border-color 0.1s, background 0.15s',
      }}
    >
      {label}
    </div>
  );
}

export function TileGrid({ rows = 3, cols = 4 }: { rows?: number; cols?: number }): React.JSX.Element {
  return (
    <section>
      <h2 style={{ fontSize: 20, margin: '0 0 12px' }}>Focus grid</h2>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: 'flex' }}>
          {Array.from({ length: cols }, (_, c) => (
            <Tile key={c} label={`${r + 1}·${c + 1}`} />
          ))}
        </div>
      ))}
    </section>
  );
}
