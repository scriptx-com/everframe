// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { sensitiveRegistry, SENSITIVE_ATTR } from '../../src/sensitive/registry.js';

afterEach(() => {
  sensitiveRegistry.__clearForTesting();
  document.body.innerHTML = '';
});

describe('sensitive ref marker ownership', () => {
  it('marks synchronously and removes its own marker after idempotent registration', () => {
    const element = document.createElement('div');
    document.body.append(element);
    sensitiveRegistry.addRef(element);
    sensitiveRegistry.addRef(element);
    expect(element.hasAttribute(SENSITIVE_ATTR)).toBe(true);
    expect(sensitiveRegistry.snapshotElements()).toEqual([element]);
    sensitiveRegistry.removeRef(element);
    expect(element.hasAttribute(SENSITIVE_ATTR)).toBe(false);
    expect(sensitiveRegistry.snapshotElements()).toEqual([]);
  });

  it('preserves preexisting host markers and classes on removal and registry cleanup', () => {
    const elements = [document.createElement('div'), document.createElement('div')];
    for (const element of elements) {
      element.setAttribute(SENSITIVE_ATTR, 'host');
      element.className = 'layout rr-block';
      document.body.append(element);
      sensitiveRegistry.addRef(element);
    }
    sensitiveRegistry.removeRef(elements[0]!);
    sensitiveRegistry.__clearForTesting();
    for (const element of elements) {
      expect(element.getAttribute(SENSITIVE_ATTR)).toBe('host');
      expect(element.className).toBe('layout rr-block');
      expect(sensitiveRegistry.isSensitive(element)).toBe(true);
    }
  });

  it('preserves host replacements of an owned marker during registration', () => {
    const element = document.createElement('div');
    sensitiveRegistry.addRef(element);
    element.setAttribute(SENSITIVE_ATTR, '');
    element.className = 'rr-block';
    sensitiveRegistry.removeRef(element);
    expect(element.getAttribute(SENSITIVE_ATTR)).toBe('');
    expect(element.className).toBe('rr-block');
  });

  it('registry cleanup removes only markers it added', () => {
    const element = document.createElement('div');
    document.body.append(element);
    sensitiveRegistry.addRef(element);
    expect(element.hasAttribute(SENSITIVE_ATTR)).toBe(true);
    sensitiveRegistry.__clearForTesting();
    expect(element.hasAttribute(SENSITIVE_ATTR)).toBe(false);
    expect(sensitiveRegistry.isSensitive(element)).toBe(false);
    expect(sensitiveRegistry.snapshotElements()).toEqual([]);
  });
});
