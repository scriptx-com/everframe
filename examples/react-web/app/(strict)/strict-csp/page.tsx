// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
export default function StrictCspPage() {
  return (
    <main style={{ padding: 24 }}>
      <h1 data-testid="strict-csp-heading">Strict CSP Fixture</h1>
      <p data-testid="csp-marker">Reporter must capture this page WITHOUT CSP violations.</p>
      <p data-testid="cc-number">4111-1111-1111-1111</p>
    </main>
  );
}
