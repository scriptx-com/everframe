// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The React half of the companion singleton. `start`, `stop` and the
// `__get*` seams are framework-free and live in `@everframe/web`
// (src/companion/singleton.ts); only this hook needs React, so only this
// hook stayed behind — keeping react out of the web SDK's always-loaded
// entry. Surfaced as `companion.useCompanion()` (and as a top-level
// `useCompanion` re-export) from src/index.ts, exactly as before.
'use client';

import { useEffect, useState } from 'react';
import {
  __getCompanionApi,
  __getCompanionRunning,
  __onCompanionRunning,
  type CompanionState,
  type CompanionAttachChallenge,
} from '@everframe/web';

/**
 * React hook returning the latest `{ state, pairUrl, code, attachedUserName,
 * resolvedName }` snapshot. Mirrors the RN `useCompanion()` zero-arg
 * signature. Reads from the singleton — for per-instance subscriptions, use
 * `createCompanion()` directly and subscribe via `onState` / `onPairUrl` /
 * `onCode` / `onAttachedUserName` / `onResolvedName`.
 *
 * `code` is the short display code from a successful `/api/companion/announce`
 * call — `null` whenever no `sdkKey` was passed to `start()`, or the
 * announce call failed for any reason (offline, revoked key, older server).
 * `attachedUserName` is the dashboard user's display name once a
 * companion-initiated bond lands — `null` on an ordinary QR pairing.
 * `resolvedName` is the server-resolved device display name (naming spec
 * 2026-08-24) — a custom rename, falling back to a host label, falling back
 * to a server-composed default; `null` until an announce response (or a live
 * `companion.name` push) supplies one.
 */
export function useCompanion(): {
  state: CompanionState;
  pairUrl: string | null;
  code: string | null;
  attachedUserName: string | null;
  resolvedName: string | null;
  attachChallenge: CompanionAttachChallenge | null;
  running: boolean;
} {
  const api = __getCompanionApi();
  const [state, setState] = useState<CompanionState>(api.getState());
  const [pairUrl, setPairUrl] = useState<string | null>(api.getPairUrl());
  const [code, setCode] = useState<string | null>(api.getCode());
  const [attachedUserName, setAttachedUserName] = useState<string | null>(
    api.getAttachedUserName(),
  );
  const [resolvedName, setResolvedName] = useState<string | null>(
    api.getResolvedName(),
  );
  const [attachChallenge, setAttachChallenge] =
    useState<CompanionAttachChallenge | null>(api.getAttachChallenge());
  const [running, setRunning] = useState<boolean>(__getCompanionRunning());

  useEffect(() => {
    setState(api.getState());
    setPairUrl(api.getPairUrl());
    setCode(api.getCode());
    setAttachedUserName(api.getAttachedUserName());
    setResolvedName(api.getResolvedName());
    setAttachChallenge(api.getAttachChallenge());
    setRunning(__getCompanionRunning());
    const offState = api.onState((_old, next) => setState(next));
    const offPair = api.onPairUrl(setPairUrl);
    const offCode = api.onCode(setCode);
    const offAttachedUserName = api.onAttachedUserName(setAttachedUserName);
    const offResolvedName = api.onResolvedName(setResolvedName);
    const offAttachChallenge = api.onAttachChallenge(setAttachChallenge);
    const offRunning = __onCompanionRunning(setRunning);
    return () => {
      offState();
      offPair();
      offCode();
      offAttachedUserName();
      offResolvedName();
      offAttachChallenge();
      offRunning();
    };
  }, [api]);

  return {
    state,
    pairUrl,
    code,
    attachedUserName,
    resolvedName,
    attachChallenge,
    running,
  };
}
