// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
"use client";

import type { ReactNode } from "react";
import { EverframeProvider } from "@everframe/react";
import { SiteNav } from "../components/SiteNav";
import { ReportFab } from "../components/ReportFab";
import {
  SessionProvider,
  UserSwitcher,
  useSession,
} from "../components/UserSwitcher";
import "../globals.css";

// Mint a real key from /admin/ → app detail → "Create SDK key" and put it in
// examples/react-web/.env.local as NEXT_PUBLIC_EVERFRAME_KEY=txx_live_…
// `txx_live_test` is the placeholder accepted only by the e2e stub server.
const EVERFRAME_KEY = process.env.NEXT_PUBLIC_EVERFRAME_KEY ?? "txx_live_test";

/**
 * Recognition is ONE PROP. It used to be <IdentityBridge/> — a component whose
 * only job was to call setIdentityToken from an effect with a deliberately
 * empty dependency array and an eslint-disable explaining why. That component
 * is gone; this is its replacement.
 *
 * `key` is the live half: changing it re-mints, dropping it signs out.
 * `headers` is re-invoked on every mint, which is what makes a rotating access
 * token work.
 */
function Shell({ children }: { children: ReactNode }) {
  const { user, getAccessToken } = useSession();
  return (
    <EverframeProvider
      config={{
        apiKey: EVERFRAME_KEY,
        // The build id is what lets the API match uploaded source maps to a report.
        appBuild: process.env.NEXT_PUBLIC_EVERFRAME_APP_BUILD,
        debug: true,
        vitals: { enabled: true },
      }}
      identity={{
        endpoint: "/api/everframe-identity",
        key: user?.id,
        headers: (): Record<string, string> => {
          const token = getAccessToken();
          return token ? { authorization: `Bearer ${token}` } : {};
        },
      }}
    >
      <SiteNav />
      <UserSwitcher />
      {children}
      <ReportFab />
    </EverframeProvider>
  );
}

export default function DefaultLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
