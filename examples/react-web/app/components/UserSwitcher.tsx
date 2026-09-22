// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Account switching is the behaviour `identity.key` exists to make correct, so
// the example does it for real. Switching flips BOTH the access token (what
// the mint endpoint authenticates) and `key` (what tells the SDK the person
// changed) — and the dashboard's People directory fills with two people.
'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEMO_USERS, issueAccessToken, type DemoUser } from '../lib/session';

interface SessionValue {
  user: DemoUser | null;
  signIn: (user: DemoUser) => void;
  signOut: () => void;
  getAccessToken: () => string | null;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<DemoUser | null>(DEMO_USERS[0] ?? null);
  const value = useMemo<SessionValue>(
    () => ({
      user,
      signIn: setUser,
      signOut: () => setUser(null),
      // Minted fresh on every call — the shape a rotating access token has.
      getAccessToken: () => (user ? issueAccessToken(user.id) : null),
    }),
    [user],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function UserSwitcher() {
  const { user, signIn, signOut } = useSession();
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 16px' }}>
      <span style={{ fontSize: 13, opacity: 0.7 }}>Signed in as {user?.name ?? 'nobody'}</span>
      {DEMO_USERS.map((u) => (
        <button key={u.id} type="button" onClick={() => signIn(u)} disabled={user?.id === u.id}>
          {u.name}
        </button>
      ))}
      <button type="button" onClick={signOut} disabled={user === null}>
        Sign out
      </button>
    </div>
  );
}
