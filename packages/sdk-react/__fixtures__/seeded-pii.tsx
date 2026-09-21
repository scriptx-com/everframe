// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/**
 * Reusable PII fixture used by:
 *   - plan 03 (screenshot redaction smoke test)
 *   - plan 06 (sensitive-rect masking spec)
 *   - plan 08 (Playwright zero-leakage e2e)
 *
 * Default-deny redaction (Phase 1) MUST scrub these values from any envelope generated
 * over this DOM. The values below are the canonical seeded-PII per Phase-1 conventions.
 */
export const SEEDED_PII = {
  creditCard: '4111-1111-1111-1111', // Luhn-valid Visa test number
  jwtBearer: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fake-signature',
  ssn: '123-45-6789',
  apiKey: 'sk_live_fake_1234567890abcdef',
  email: 'pii-fixture@example.com',
  password: 'SuperSecret!2026',
} as const;

export function SeededPiiPage(): JSX.Element {
  return (
    <div data-testid="seeded-pii-page">
      <h1>Seeded PII Fixture</h1>
      <form>
        <label htmlFor="cc">Credit card</label>
        <input id="cc" type="text" defaultValue={SEEDED_PII.creditCard} />

        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" defaultValue={SEEDED_PII.password} />

        <label htmlFor="ssn">SSN</label>
        <input id="ssn" type="text" defaultValue={SEEDED_PII.ssn} />

        <label htmlFor="email">Email</label>
        <input id="email" type="email" defaultValue={SEEDED_PII.email} />
      </form>
      <pre data-testid="seeded-pii-jwt">{SEEDED_PII.jwtBearer}</pre>
      <pre data-testid="seeded-pii-apikey">{SEEDED_PII.apiKey}</pre>
    </div>
  );
}
