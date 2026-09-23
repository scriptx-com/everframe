// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Attach-time device-name badge (naming spec 2026-08-24 §4). Shows the
// resolved display name + pairing code in a corner chip while a dashboard
// member is attached, so the physical screen can be matched to its
// dashboard row ("which of these five emulators is this?").
//
// IDENTIFICATION ONLY — this is NOT the fail-closed "Sharing screen to
// phone" indicator removed on 2026-08-13, has no visibility proof, gates
// nothing, and must never be cited as a privacy mitigation.
//
// CAPTURE EXCLUSION (hard requirement, spec §4): all three markers, per the
// CompanionPinCard precedent (see reporter-ui/CompanionPinCard.tsx) —
//   • data-everframe-skip-capture → screenshot clone filter (screenshot.ts
//     filterNode) + the UI-tree DOM walk (ui-tree-dom.ts)
//   • data-everframe-sensitive    → SENSITIVE_ATTR, the replay recorder's
//     sensitive-registry masking (mask-mapping.ts)
//   • className "rr-block"       → rrweb blockClass (recorder.ts
//     RR_BLOCK_CLASS); STATIC because the recorder's sensitiveElements()
//     sweep runs once at start(), and this badge mounts later (on attach) —
//     rrweb's own blockClass check is evaluated dynamically per node on
//     every mutation/snapshot, so a static class on the root is honored no
//     matter when the node appears. All three are required — they cover
//     different capture pipelines and none of them subsumes another.
'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  __getCompanionApi,
  __getCompanionBadgeConfig,
  type BadgePosition,
} from '../companion/singleton.js';
import {
  __getCompanionBadgeServerConfig,
  __subscribeCompanionBadgeServerConfig,
} from '../companion/server-config.js';

const POSITION_STYLE: Record<BadgePosition, React.CSSProperties> = {
  // 24px insets keep the chip inside TV overscan-safe margins.
  'bottom-right': { right: 24, bottom: 24 },
  'bottom-left': { left: 24, bottom: 24 },
  'top-right': { right: 24, top: 24 },
  'top-left': { left: 24, top: 24 },
};

export function CompanionBadge(): React.ReactElement | null {
  const api = __getCompanionApi();
  const [attached, setAttached] = useState(api.getAttachedUserName() !== null);
  const [name, setName] = useState(api.getResolvedName());
  const [code, setCode] = useState(api.getCode());

  useEffect(() => {
    setAttached(api.getAttachedUserName() !== null);
    setName(api.getResolvedName());
    setCode(api.getCode());
    const offAttached = api.onAttachedUserName((n) => setAttached(n !== null));
    const offName = api.onResolvedName(setName);
    const offCode = api.onCode(setCode);
    return () => { offAttached(); offName(); offCode(); };
  }, [api]);

  // A server-driven config change (dashboard toggle/reposition) must be
  // reflected immediately — this component otherwise only re-renders on
  // companion attach/name/code state changes. React's canonical external-store
  // hook (codex round-1 fix A): unlike a manual subscribe-in-useEffect +
  // force-render counter, this has no subscribe-window race — a write landing
  // between render and effect-commit is never missed, because React re-checks
  // the snapshot after subscribing and re-renders if it already changed. The
  // returned value is unused directly; the resolved config below still comes
  // from __getCompanionBadgeConfig(). Requires __getCompanionBadgeServerConfig
  // to return a referentially stable snapshot (server-config.ts's setter
  // stores the object it was given; the getter returns it unchanged).
  useSyncExternalStore(
    __subscribeCompanionBadgeServerConfig,
    __getCompanionBadgeServerConfig,
    __getCompanionBadgeServerConfig,
  );

  const config = __getCompanionBadgeConfig();
  if (!config.enabled || !attached) return null;
  const label = [name, code].filter((s): s is string => s !== null).join(' · ');
  if (label === '') return null;

  return (
    <div
      data-testid="everframe-companion-badge"
      role="status"
      // See the CAPTURE EXCLUSION note above — all three markers required.
      data-everframe-skip-capture="true"
      data-everframe-sensitive=""
      className="rr-block"
      style={{
        position: 'fixed',
        ...POSITION_STYLE[config.position],
        // One BELOW --everframe-z-modal (reporter.css.ts: 2147483646), matching
        // CompanionPinCard's own layering — a tie would paint over an open
        // reporter; staying strictly lower keeps "an open reporter still
        // wins" true for the badge too.
        zIndex: 2147483645,
        padding: '6px 12px',
        borderRadius: 999,
        font: '500 13px/1.4 system-ui, sans-serif',
        background: 'rgba(17, 17, 17, 0.82)',
        color: '#fff',
        pointerEvents: 'none',
      }}
    >
      {label}
    </div>
  );
}
