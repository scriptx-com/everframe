// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Synthetic PII fixtures for the PRIV-03 zero-leakage suite. NONE of these are real
// personal data — all synthetic, all designed to exercise each redaction path.
import type { ReportEnvelope } from '@traceitx/protocol';

export const TEST_PII = {
  password: 'super-secret-password-123',
  jwtToken: 'eyJraWQiOiJBQkNERUYiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MTIzIn0.signaturepart12345',
  creditCardValid: '4111-1111-1111-1111', // Luhn-valid Visa test number
  creditCardInvalid: '4111-1111-1111-1112', // Luhn-INVALID (last digit changed)
  ssn: '123-45-6789',
  email: 'leak@example.com',
  queryToken: 'abc123secret',
};

export function buildSeededPIIEnvelope(): ReportEnvelope {
  return {
    protocolVersion: '1.0',
    reportId: '01939c34-7b8f-7000-8000-000000000099',
    submittedAt: '2026-04-29T16:00:00.000Z',
    sdk: { name: 'traceitx-react', version: '0.0.0', platform: 'web', formFactor: 'desktop' },
    reporter: { title: 'PII probe', description: 'seeded fixture' },
    captures: { screenshot: false, uiTree: true, focus: false, logs: true, network: true },
    captureControl: { included: ['uiTree', 'logs', 'network'], excluded: [] },
    payload: {
      uiTree: {
        root: {
          componentType: 'div',
          identifiers: {},
          rect: { x: 0, y: 0, width: 100, height: 100 },
          safeProps: { 'aria-label': `Customer SSN ${TEST_PII.ssn}` },
          children: [
            {
              componentType: 'input',
              identifiers: { type: 'password' },
              rect: { x: 10, y: 10, width: 80, height: 20 },
              safeProps: { value: TEST_PII.password, componentType: 'PasswordField' },
              children: [],
            },
            {
              componentType: 'input',
              identifiers: { type: 'text' },
              rect: { x: 10, y: 40, width: 80, height: 20 },
              safeProps: {
                value: `My card ${TEST_PII.creditCardValid}`,
                componentType: 'TextField',
                placeholder: 'enter card',
              },
              children: [],
            },
          ],
        },
        capturedAt: '2026-04-29T16:00:00.000Z',
        rendererHint: 'dom',
      },
      logs: [
        { level: 'error', message: `Auth failed: token=${TEST_PII.jwtToken}`, timestamp: 1000 },
        { level: 'info', message: `Card ${TEST_PII.creditCardValid} accepted`, timestamp: 1100 },
        { level: 'info', message: `Invalid card: ${TEST_PII.creditCardInvalid}`, timestamp: 1200 },
        { level: 'info', message: `SSN ${TEST_PII.ssn} stored`, timestamp: 1300 },
      ],
      network: [
        {
          method: 'POST',
          url: `https://api.example.com/users?api_key=${TEST_PII.queryToken}`,
          status: 200,
          startedAt: 1500,
          headers: {
            authorization: `Bearer ${TEST_PII.jwtToken}`,
            'x-api-key': 'secretkey',
            'content-type': 'application/json',
          },
        },
      ],
    },
    context: {
      app: { name: 'app', version: '1.0.0' },
      device: {
        os: 'macos',
        osVersion: '14.4',
        screenSize: { width: 1920, height: 1080 },
        pixelRatio: 2,
        locale: 'en-US',
        timezone: 'America/New_York',
      },
    },
    attachments: [],
  } as unknown as ReportEnvelope;
}
