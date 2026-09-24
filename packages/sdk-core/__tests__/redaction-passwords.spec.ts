// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import type { ReportEnvelope, UINode } from '@everframe/protocol';
import { UITree } from '@everframe/protocol';
import { applyRedaction } from '../src/redaction/engine.js';

function envWithRoot(root: UINode): ReportEnvelope {
  return {
    protocolVersion: '1.0',
    reportId: '01939c34-7b8f-7000-8000-000000000001',
    submittedAt: '2026-04-29T16:00:00.000Z',
    sdk: { name: 'everframe-react', version: '0.0.0', platform: 'web', formFactor: 'desktop' },
    reporter: { title: 'pwd', description: 'pwd' },
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

describe('PRIV-01: password input auto-mask', () => {
  it('input[type=password] → sensitive=true, children dropped, rect in maskPlan', () => {
    const root: UINode = {
      componentType: 'input',
      identifiers: { type: 'password' },
      rect: { x: 5, y: 5, width: 50, height: 20 },
      safeProps: { value: 'plaintext-pw', componentType: 'PasswordField' },
      children: [
        {
          componentType: 'span',
          identifiers: {},
          rect: { x: 6, y: 6, width: 10, height: 10 },
          safeProps: {},
          children: [],
        },
      ],
    };
    const env = envWithRoot(root);
    const { envelope, maskPlan } = applyRedaction(env, {});
    const newRoot = UITree.parse(envelope.payload.uiTree).root;
    expect(newRoot.sensitive).toBe(true);
    expect(newRoot.children).toEqual([]);
    expect(maskPlan).toContainEqual({ x: 5, y: 5, width: 50, height: 20 });
    // Password value should be stripped from safeProps (default-deny).
    expect(newRoot.safeProps['value']).toBeUndefined();
  });

  it('RN secureTextEntry=true → same auto-mask treatment', () => {
    const root: UINode = {
      componentType: 'TextInput',
      identifiers: { secureTextEntry: 'true' },
      rect: { x: 10, y: 10, width: 100, height: 30 },
      safeProps: { value: 'rn-secret', componentType: 'TextInput' },
      children: [
        {
          componentType: 'view',
          identifiers: {},
          rect: { x: 11, y: 11, width: 5, height: 5 },
          safeProps: {},
          children: [],
        },
      ],
    };
    const env = envWithRoot(root);
    const { envelope, maskPlan } = applyRedaction(env, {});
    const newRoot = UITree.parse(envelope.payload.uiTree).root;
    expect(newRoot.sensitive).toBe(true);
    expect(newRoot.children).toEqual([]);
    expect(maskPlan).toContainEqual({ x: 10, y: 10, width: 100, height: 30 });
  });
});
