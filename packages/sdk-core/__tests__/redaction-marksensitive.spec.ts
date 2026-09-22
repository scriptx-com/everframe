// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import type { ReportEnvelope, UINode } from '@traceitx/protocol';
import { UITree } from '@traceitx/protocol';
import { applyRedaction } from '../src/redaction/engine.js';

function envWithRoot(root: UINode): ReportEnvelope {
  return {
    protocolVersion: '1.0',
    reportId: '01939c34-7b8f-7000-8000-000000000002',
    submittedAt: '2026-04-29T16:00:00.000Z',
    sdk: { name: 'traceitx-react', version: '0.0.0', platform: 'web', formFactor: 'desktop' },
    reporter: { title: 'mark', description: 'mark' },
    captures: { screenshot: false, uiTree: true, focus: false, logs: false, network: false },
    captureControl: { included: ['uiTree'], excluded: [] },
    payload: {
      uiTree: { root, capturedAt: '2026-04-29T16:00:00.000Z', rendererHint: 'dom' },
    },
    context: {
      app: { name: 'app', version: '1.0.0' },
      device: {
        os: 'macos',
        osVersion: '14.4',
        screenSize: { width: 1, height: 1 },
        pixelRatio: 1,
        locale: 'en-US',
        timezone: 'UTC',
      },
    },
    attachments: [],
  } as unknown as ReportEnvelope;
}

describe('PRIV-02: <Sensitive>/markSensitive pre-set on UINode', () => {
  it('node with sensitive=true emits rect in maskPlan and drops children/safeProps', () => {
    const root: UINode = {
      componentType: 'div',
      identifiers: {},
      rect: { x: 100, y: 200, width: 300, height: 50 },
      safeProps: { someText: 'leak-this', componentType: 'PaymentSection' },
      sensitive: true,
      children: [
        {
          componentType: 'input',
          identifiers: { type: 'text' },
          rect: { x: 110, y: 210, width: 100, height: 20 },
          safeProps: { value: 'card-1234' },
          children: [],
        },
      ],
    };
    const env = envWithRoot(root);
    const { envelope, maskPlan } = applyRedaction(env, {});
    const newRoot = UITree.parse(envelope.payload.uiTree).root;
    expect(newRoot.sensitive).toBe(true);
    expect(newRoot.children).toEqual([]);
    expect(maskPlan).toContainEqual({ x: 100, y: 200, width: 300, height: 50 });
    // safeProps not in default allowlist must be stripped.
    expect(newRoot.safeProps['someText']).toBeUndefined();
    expect(newRoot.safeProps['componentType']).toBe('PaymentSection');
  });
});
