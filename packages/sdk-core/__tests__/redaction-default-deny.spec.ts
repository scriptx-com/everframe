// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import type { ReportEnvelope, UINode } from '@everframe/protocol';
import { UITree } from '@everframe/protocol';
import { applyRedaction } from '../src/redaction/engine.js';

function envWithRoot(root: UINode): ReportEnvelope {
  return {
    protocolVersion: '1.0',
    reportId: '01939c34-7b8f-7000-8000-000000000003',
    submittedAt: '2026-04-29T16:00:00.000Z',
    sdk: { name: 'everframe-react', version: '0.0.0', platform: 'web', formFactor: 'desktop' },
    reporter: { title: 't', description: 'd' },
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

describe('PRIV-03: default-deny on safeProps', () => {
  it('strips arbitrary text props; preserves componentType + displayName by default', () => {
    const root: UINode = {
      componentType: 'div',
      identifiers: {},
      rect: { x: 0, y: 0, width: 100, height: 100 },
      safeProps: {
        value: 'secret',
        componentType: 'TextField',
        displayName: 'LoginField',
        someTextProp: 'leaky',
        'aria-label': 'My label',
      },
      children: [],
    };
    const env = envWithRoot(root);
    const { envelope } = applyRedaction(env, {});
    const newRoot = UITree.parse(envelope.payload.uiTree).root;
    expect(newRoot.safeProps['value']).toBeUndefined();
    expect(newRoot.safeProps['someTextProp']).toBeUndefined();
    expect(newRoot.safeProps['aria-label']).toBeUndefined();
    expect(newRoot.safeProps['componentType']).toBe('TextField');
    expect(newRoot.safeProps['displayName']).toBe('LoginField');
  });

  it('respects user-provided allowProps allowlist', () => {
    const root: UINode = {
      componentType: 'div',
      identifiers: {},
      rect: { x: 0, y: 0, width: 100, height: 100 },
      safeProps: {
        'data-testid': 'login-form',
        'data-other': 'should be stripped',
        componentType: 'Form',
      },
      children: [],
    };
    const env = envWithRoot(root);
    const { envelope } = applyRedaction(env, { allowProps: ['data-testid'] });
    const newRoot = UITree.parse(envelope.payload.uiTree).root;
    expect(newRoot.safeProps['data-testid']).toBe('login-form');
    expect(newRoot.safeProps['data-other']).toBeUndefined();
    expect(newRoot.safeProps['componentType']).toBe('Form');
  });
});
