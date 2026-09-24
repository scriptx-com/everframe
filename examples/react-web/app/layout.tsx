// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { ReactNode } from "react";

export const metadata = {
  title: "Everframe Web SDK Example",
  description: "Dogfood + Playwright fixture for @everframe/react",
};

/**
 * Root layout owns ONLY the html+body shell. The EverframeProvider lives one level
 * down, in either `(default)/layout.tsx` (standard) or `(strict)/layout.tsx`
 * (strict-CSP nonce path). This avoids mounting two nested providers (which would
 * render two bubbles and break Playwright's strict-mode locator resolution).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
