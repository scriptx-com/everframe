// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/**
 * Minimal valid ReportEnvelope fixture for testing.
 * Deep-cloned per call to prevent test isolation issues.
 */
export function baseEnvelope(): Record<string, any> {
  return structuredClone({
    protocolVersion: '1.0',
    reportId: '01939c34-7b8f-7000-8000-000000000001',
    submittedAt: '2026-04-29T16:00:00.000Z',
    sdk: {
      name: 'traceitx-react',
      version: '0.0.0',
      platform: 'web' as const,
      formFactor: 'desktop' as const,
    },
    reporter: {
      title: 'Test report',
      description: 'Minimal valid envelope',
    },
    captures: {
      screenshot: false,
      uiTree: false,
      focus: false,
      logs: false,
      network: false,
    },
    captureControl: {
      included: [],
      excluded: [],
    },
    payload: {},
    context: {
      app: { name: 'test-app', version: '1.0.0' },
      device: {
        os: 'macos' as const,
        osVersion: '14.4',
        screenSize: { width: 1920, height: 1080 },
        pixelRatio: 2,
        locale: 'en-US',
        timezone: 'America/New_York',
      },
    },
    attachments: [],
  });
}
