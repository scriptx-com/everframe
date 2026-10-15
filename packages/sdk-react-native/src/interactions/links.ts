// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { Linking } from 'react-native';
import { URL } from 'react-native-url-polyfill/js/URL.js';
import Native from '../NativeEverframe.js';
import { redactStringContent } from '@everframe/sdk-core';
import type { InteractionPolicy } from './policy.js';
import type { InteractionScope } from './registration.js';
import { bounded, captureInteractionOperation, type InteractionBridge } from './operation.js';
/** Split before decoding: URL normalization must not conceal ambiguous path segments. */
export function sanitizeInteractionUrl(
  raw: unknown,
  policy: InteractionPolicy,
): string | undefined {
  try {
    if (
      policy.disabled ||
      typeof raw !== 'string' ||
      raw.length > 8192 ||
      /%(?![0-9A-Fa-f]{2})/.test(raw) ||
      /[\u0000-\u0020\u007f\\\uD800-\uDFFF]/u.test(raw)
    )
      return;
    // Use our bundled parser: bare RN's global URL can misclassify private
    // path/query characters as the host. Apps need no global URL patch.
    const parsed = new URL(raw);
    if (!parsed.host) {
      const payload = raw.slice(raw.indexOf(':') + 1);
      // Empty authorities are malformed, except a file URL's local path.
      if (payload.startsWith('//') && !(parsed.protocol === 'file:' && payload.startsWith('///')))
        return;
      if (/[\u0000-\u001f\u007f\\]/u.test(decodeURIComponent(payload))) return;
      return parsed.protocol.toLowerCase();
    }
    const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+([^?#]*)(?:\?([^#]*))?(?:#.*)?$/.exec(raw);
    if (!match) return;
    const parts = match[1]!.split('/').map((part) => decodeURIComponent(part));
    if (
      parts.some((part) => part === '.' || part === '..' || /[/%\\\u0000-\u001f\u007f]/u.test(part))
    )
      return;
    const origin = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}`;
    const rule = policy.urlRules.find((rule) => rule.origin === origin),
      path = parts.join('/');
    const safePath =
      rule?.literalPaths.find((p) => p === path) ??
      rule?.routes.find((route) => {
        const expected = route.split('/');
        return (
          expected.length === parts.length &&
          expected.every((p, i) => p === parts[i] || (p.startsWith(':') && parts[i] !== ''))
        );
      }) ??
      '';
    const query: string[] = [],
      seen = new Set<string>();
    for (const pair of (match[2] ?? '').split('&')) {
      const index = pair.indexOf('='),
        key = decodeURIComponent((index < 0 ? pair : pair.slice(0, index)).replace(/\+/g, ' ')),
        value = decodeURIComponent((index < 0 ? '' : pair.slice(index + 1)).replace(/\+/g, ' '));
      if (!rule?.queryKeys.includes(key) || seen.has(key) || query.length >= 16) continue;
      seen.add(key);
      const safeKey = bounded(redactStringContent(key, {}), 128),
        safeValue = bounded(redactStringContent(value, {}), 128);
      if (safeKey && safeValue !== undefined)
        query.push(`${encodeURIComponent(safeKey)}=${encodeURIComponent(safeValue)}`);
    }
    const base = redactStringContent(origin + safePath, {});
    if (base.length > 1024) return;
    const full = base + (query.length ? '?' + query.join('&') : '');
    return full.length <= 1024 ? full : base;
  } catch {
    return;
  }
}
interface LinkSource {
  addEventListener(type: 'url', listener: (event: { url: string }) => void): { remove(): void };
  getInitialURL(): Promise<string | null | undefined>;
}
let initialRequested = false;
let installed: { owner: object; dispose(): void } | undefined;
/** One process initial request; URL equality cannot identify distinct native deliveries. */
export function installInteractionLinks(
  runtime: { interactionEvents: InteractionScope },
  linking: LinkSource = Linking,
  bridge: InteractionBridge = Native,
): () => void {
  const scope = runtime.interactionEvents,
    owner = scope.owner();
  if (!owner || scope.policy.disabled) return () => {};
  if (installed?.owner === owner) return installed.dispose;
  installed?.dispose();
  let closed = false,
    subscription: { remove(): void } | undefined;
  const dispose = () => {
    if (closed) return;
    closed = true;
    if (installed?.dispose === dispose) installed = undefined;
    try {
      subscription?.remove();
    } catch {}
  };
  const emit = (
    raw: unknown,
    delivery: 'initial' | 'subsequent',
    capture = captureInteractionOperation(scope, bridge),
  ) => {
    if (closed || scope.owner() !== owner || !capture) return;
    const url = sanitizeInteractionUrl(raw, scope.policy);
    if (url) capture.emit({ type: 'deep_link', url, delivery }, 'native');
  };
  try {
    const capture = captureInteractionOperation(scope, bridge);
    if (!capture) return dispose;
    subscription = linking.addEventListener('url', (event) => emit(event.url, 'subsequent'));
    installed = { owner, dispose };
    if (!initialRequested) {
      initialRequested = true;
      void linking.getInitialURL().then(
        (url) => emit(url, 'initial', capture),
        () => {},
      );
    }
  } catch {
    dispose();
  }
  return dispose;
}
