// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Default-deny redaction engine (PRIV-01/02/03). Runs before bytes leave the device.
//
// Rule order (RESEARCH.md Pattern 5 lines 351-364):
//   1. <Sensitive>/markSensitive (pre-set sensitive flag) → rect to maskPlan, drop subtree
//   2. Built-in always-on:
//      - Password / RN secureTextEntry → auto-sensitive
//      - Auth headers (authorization|x-api-key|set-cookie|cookie|proxy-authorization) → [REDACTED]
//      - JWT shape → [REDACTED:JWT]
//      - Credit card (Luhn-validated) → [REDACTED:CC]
//      - US SSN → [REDACTED:SSN]
//   3. Default-deny on safeProps (only allowlist survives)
//   4. Customer customRules (header|pattern|urlParam)
//   5. Customer email rule (off by default)
import { UITree, type ReportEnvelope, type UINode } from '@traceitx/protocol';
import type { CustomRule } from '../types/redaction.js';
import type { Rect } from '../types/platform.js';
import { luhnValid } from './luhn.js';

export interface RedactionConfig {
  maskInputs?: Array<'email' | 'tel' | 'creditcard' | 'ssn'>;
  allowProps?: string[];
  customRules?: CustomRule[];
}

// Reporter bearer credentials (recognition spec 2026-08-06) are included
// alongside the always-on auth headers: an app that instruments fetch
// globally captures its OWN calls to /api/reporter/*, so these land in
// payload.network[].headers unless masked here. `x-tx-device-token`
// authorizes thread reads; `x-tx-identity-token` can bootstrap a device.
// Keep in parity with the server's redact.ts SENSITIVE_HEADERS.
const SENSITIVE_HEADERS =
  /^(authorization|x-api-key|set-cookie|cookie|proxy-authorization|x-tx-device-token|x-tx-identity-token)$/i;
// Inline JWT match (substring within larger strings).
const JWT_INLINE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const SSN_US = /\b\d{3}-\d{2}-\d{4}\b/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const SAFE_TEXT_PROPS = new Set(['componentType', 'displayName']);

export function applyRedaction(
  envelope: ReportEnvelope,
  config: RedactionConfig
): { envelope: ReportEnvelope; maskPlan: Rect[] } {
  const maskPlan: Rect[] = [];
  // Deep clone via structured-clone-equivalent JSON round-trip to avoid mutating input.
  const cloned: ReportEnvelope = JSON.parse(JSON.stringify(envelope));

  if (cloned.payload.uiTree) {
    // Historical/unknown extension data still needs privacy protection even
    // though uiTree is no longer part of the supported envelope contract.
    const tree = UITree.parse(cloned.payload.uiTree);
    redactUITree(tree.root, config, maskPlan);
    cloned.payload.uiTree = tree;
  }
  if (cloned.payload.network) {
    cloned.payload.network = (cloned.payload.network as unknown[]).map((n) =>
      redactNetworkEntry(n as Record<string, unknown>, config)
    );
  }
  if (cloned.payload.logs) {
    cloned.payload.logs = (cloned.payload.logs as unknown[]).map((l) =>
      redactLogEntry(l as Record<string, unknown>, config)
    );
  }

  return { envelope: cloned, maskPlan };
}

function redactUITree(node: UINode, config: RedactionConfig, maskPlan: Rect[]): void {
  const allowSet = new Set([...SAFE_TEXT_PROPS, ...(config.allowProps ?? [])]);

  // Default-deny: drop every safeProp not in the allowlist.
  const stripped: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(node.safeProps)) {
    if (allowSet.has(k)) {
      stripped[k] = typeof v === 'string' ? redactStringContent(v, config) : v;
    }
  }
  node.safeProps = stripped;

  // Pre-marked sensitive (PRIV-02 markSensitive / <Sensitive> wrapper)
  if (node.sensitive) {
    maskPlan.push({ ...node.rect });
    node.children = [];
    return;
  }

  // Auto-sensitive: password / RN secureTextEntry (PRIV-01)
  if (
    (node.componentType === 'input' && node.identifiers['type'] === 'password') ||
    node.identifiers['secureTextEntry'] === 'true'
  ) {
    node.sensitive = true;
    maskPlan.push({ ...node.rect });
    node.children = [];
    return;
  }

  for (const child of node.children) {
    redactUITree(child, config, maskPlan);
  }
}

function redactNetworkEntry(
  entry: Record<string, unknown>,
  config: RedactionConfig
): Record<string, unknown> {
  const headers = (entry['headers'] as Record<string, string> | undefined) ?? {};
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    masked[k] = SENSITIVE_HEADERS.test(k)
      ? '[REDACTED]'
      : redactStringContent(String(v), config);
  }
  const url = entry['url'];
  return {
    ...entry,
    headers: masked,
    ...(typeof url === 'string' ? { url: redactStringContent(url, config) } : {}),
  };
}

function redactLogEntry(
  entry: Record<string, unknown>,
  config: RedactionConfig
): Record<string, unknown> {
  const message = typeof entry['message'] === 'string' ? (entry['message'] as string) : '';
  return { ...entry, message: redactStringContent(message, config) };
}

export function redactStringContent(s: string, config: RedactionConfig): string {
  // 1. JWT shape — inline matches first (3 dot-separated >=8-char segments)
  s = s.replace(JWT_INLINE, '[REDACTED:JWT]');
  // 2. SSN
  s = s.replace(SSN_US, '[REDACTED:SSN]');
  // 3. Credit card (Luhn-validated)
  s = redactCreditCards(s);
  // 4. Customer custom patterns
  for (const rule of config.customRules ?? []) {
    if (rule.type === 'pattern') {
      s = s.replace(rule.match, rule.replacement ?? '[REDACTED]');
    } else if (rule.type === 'urlParam') {
      const pattern =
        rule.match instanceof RegExp
          ? rule.match
          : new RegExp(`(${rule.match}=)[^&]+`, 'g');
      s = s.replace(pattern, rule.replacement ?? '[REDACTED]');
    } else if (rule.type === 'header') {
      // Header rules are applied at the header layer (redactNetworkEntry already handles
      // the always-on set); this branch lets customers add header-name patterns matched
      // inline against any string. Conservative: replace the entire match.
      const pattern = rule.match instanceof RegExp ? rule.match : new RegExp(rule.match, 'gi');
      s = s.replace(pattern, rule.replacement ?? '[REDACTED]');
    }
  }
  // 5. Customer email rule (off by default)
  if (config.maskInputs?.includes('email')) {
    s = s.replace(EMAIL_REGEX, '[REDACTED:EMAIL]');
  }
  return s;
}

function redactCreditCards(s: string): string {
  return s.replace(/\b\d[\d\s-]{11,21}\d\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return m;
    return luhnValid(digits) ? '[REDACTED:CC]' : m;
  });
}
