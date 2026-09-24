// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The strict-CSP document's whole bootstrap. Plain init() with no framework —
// under test here is the cspNonce path, and a component tree would only add
// styles the SDK does not own.
import { init } from '@everframe/web';
import { STATIC_NONCE } from './csp-nonce';

const everframe = init({
  apiKey: 'txx_live_test',
  appVersion: '0.0.1-vue',
  cspNonce: STATIC_NONCE,
});
(window as unknown as Record<string, unknown>)['__everframe'] = everframe;

document
  .querySelector('[data-testid=everframe-bubble]')
  ?.addEventListener('click', () => void everframe.open().catch(() => {}));
