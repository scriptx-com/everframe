// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Built-in attach-PIN surface (spec 2026-08-19). Mounted unconditionally by
// EverframeProvider; renders nothing until an attach.challenge is live on the
// companion singleton AND the host left attachPinUi at 'builtin'. An attach
// request can arrive while the user is on ANY screen — this card cannot live
// on the host's companion screen, which may be unmounted.
'use client';
import { useEffect, useState } from 'react';
import { __getCompanionApi, __getAttachPinUiMode } from '../companion/singleton.js';
import type { CompanionAttachChallenge } from '../companion/state.js';

export function CompanionPinCard(): React.ReactElement | null {
  const api = __getCompanionApi();
  const [challenge, setChallenge] = useState<CompanionAttachChallenge | null>(
    api.getAttachChallenge(),
  );
  useEffect(() => api.onAttachChallenge(setChallenge), [api]);
  // Local expiry: the server's cleared/expired frame rides the sweeper,
  // which ticks every 60s — worst case a dead code lingers a full minute.
  // ttlMs is authoritative enough for DISPLAY: hide locally at expiry and
  // let the server frame (whenever it lands) be a no-op.
  useEffect(() => {
    if (challenge === null) return;
    const timer = setTimeout(() => setChallenge(null), challenge.ttlMs);
    return () => clearTimeout(timer);
  }, [challenge]);
  if (challenge === null || __getAttachPinUiMode() !== 'builtin') return null;
  return (
    <div
      role="status"
      data-everframe-pin-card=""
      // The code rendered here is a live attach-consent secret — it must
      // never rasterize into a submitted screenshot or serialize into a
      // replay recording. `data-everframe-skip-capture="true"` drops this
      // subtree from both the screenshot clone filter (screenshot.ts) and
      // the UI-tree DOM walk (ui-tree-dom.ts); `data-everframe-sensitive`
      // is the SENSITIVE_ATTR the replay recorder maps onto rrweb's
      // blockSelector (mask-mapping.ts) so the subtree is never serialized
      // into a replay event either. Both are required — they cover
      // different capture pipelines.
      //
      // `className="rr-block"` (recorder.ts RR_BLOCK_CLASS) is a THIRD,
      // independent belt: `sensitiveElements()` is only read once, at
      // recorder.start(), to seed the initial rr-block mapping — this card
      // can mount well after recording has already started (an attach
      // request can land on any screen, any time), so it would never be
      // swept into that one-shot pass. rrweb's own `blockClass` check,
      // unlike our one-shot mapping, is evaluated dynamically per node on
      // every mutation/snapshot — so a static `rr-block` class on the root
      // is honored no matter when the node appears. This also matters
      // because REDACTION_DISABLED currently skips the post-serialization
      // scrub entirely (mask-mapping.ts), so rrweb's live blockClass is the
      // ONLY thing standing between a late-mounted card and a raw code in
      // the replay stream.
      className="rr-block"
      data-everframe-skip-capture="true"
      data-everframe-sensitive=""
      style={{
        // One BELOW --everframe-z-modal (reporter.css.ts: 2147483646) — this card
        // mounts after <ReporterDialog/> in provider.tsx, so a TIE would
        // paint on top of an open reporter. Staying strictly lower is what
        // makes "an open reporter still wins" actually true.
        position: 'fixed', top: 16, right: 16, zIndex: 2147483645,
        background: '#111', color: '#fff', borderRadius: 12,
        padding: '14px 18px', fontFamily: 'system-ui, sans-serif',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)', maxWidth: 280,
      }}
    >
      <div style={{ fontSize: 13, opacity: 0.8 }}>
        {challenge.requestedByName} wants to connect
      </div>
      <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: '0.2em', fontFamily: 'ui-monospace, monospace' }}>
        {challenge.code}
      </div>
      <div style={{ fontSize: 12, opacity: 0.6 }}>
        Enter this code in the Everframe dashboard
      </div>
    </div>
  );
}
