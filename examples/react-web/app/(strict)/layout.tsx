// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { ReactNode } from 'react';
import { TraceItXProvider } from '@traceitx/react';
import { ReportFab } from '../components/ReportFab';

const TRACEITX_KEY = process.env.NEXT_PUBLIC_TRACEITX_KEY ?? 'txx_live_test';
const STATIC_NONCE = 'STATIC_TEST_NONCE_FOR_PLAYWRIGHT';

/**
 * Strict-CSP route-group layout. No nav, no globals.css — the fixture must
 * stay minimal so CSP violations can only come from the SDK under test.
 * ReportFab is the host-owned reporter trigger the specs click; it styles
 * itself via a CSS module (a 'self'-served stylesheet, legal under the
 * strict style-src) rather than inline styles, which this CSP blocks.
 */
export default function StrictCspLayout({ children }: { children: ReactNode }) {
  return (
    <TraceItXProvider
      config={{ apiKey: TRACEITX_KEY, appBuild: process.env.NEXT_PUBLIC_TRACEITX_APP_BUILD, cspNonce: STATIC_NONCE, debug: true, vitals: { enabled: true } }}
    >
      {children}
      <ReportFab />
    </TraceItXProvider>
  );
}
