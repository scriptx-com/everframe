// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

export interface InteractionUrlRule {
  origin: string;
  queryKeys: string[];
  routes: string[];
  literalPaths: string[];
}

export interface InteractionPolicy {
  disabled: boolean;
  valueTestIds: string[];
  urlRules: InteractionUrlRule[];
  launchArgumentKeys: string[];
}

const defaults = (disabled = false): InteractionPolicy => ({
  disabled,
  valueTestIds: [],
  urlRules: [],
  launchArgumentKeys: [],
});

// Read data properties only: host getters must not participate in permission decisions.
function own(input: unknown, key: string): unknown {
  if (input === null || typeof input !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) throw new TypeError('Accessor policy is not supported');
  return descriptor.value;
}

function identifier(input: unknown, max: number): input is string {
  return (
    typeof input === 'string' &&
    input.length > 0 &&
    input.length <= max &&
    input.trim() === input &&
    !/[\u0000-\u001f\u007f\uD800-\uDFFF*]/u.test(input)
  );
}

function entries(input: unknown): unknown[] {
  if (!Array.isArray(input)) return [];
  const length = own(input, 'length');
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 64)
    return [];
  return Array.from({ length }, (_, index) => own(input, String(index)));
}

function strings(input: unknown, max: number): string[] {
  return [...new Set(entries(input).filter((entry): entry is string => identifier(entry, max)))];
}

function origin(input: unknown): string | undefined {
  if (!identifier(input, 1024)) return undefined;
  try {
    const parsed = new URL(input);
    if (!parsed.host || parsed.username || parsed.password || parsed.search || parsed.hash)
      return undefined;
    if (parsed.pathname && parsed.pathname !== '/') return undefined;
    const canonical = `${parsed.protocol}//${parsed.host}`;
    // Do not silently turn a broader/malformed declaration into authorization.
    return input === canonical || input === `${canonical}/` ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function path(input: string, template: boolean): boolean {
  if (!input.startsWith('/') || /[?#\\%]/u.test(input)) return false;
  return input
    .split('/')
    .every(
      (part) =>
        part !== '.' &&
        part !== '..' &&
        (!part.includes(':') || (template && /^:[A-Za-z][A-Za-z0-9_]*$/u.test(part))),
    );
}

/** Local permissions only. Invalid host input cannot grant value capture. */
export function normalizeInteractionPolicy(input: unknown): InteractionPolicy {
  try {
    const disabled = own(input, 'disabled');
    if (disabled !== undefined && typeof disabled !== 'boolean') return defaults(true);
    if (disabled === true) return defaults(true);
    const urlRules: InteractionUrlRule[] = [];
    for (const rule of entries(own(input, 'urlRules'))) {
      const safeOrigin = origin(own(rule, 'origin'));
      if (!safeOrigin) continue;
      urlRules.push({
        origin: safeOrigin,
        queryKeys: strings(own(rule, 'queryKeys'), 128),
        routes: strings(own(rule, 'routes'), 1024).filter((entry) => path(entry, true)),
        literalPaths: strings(own(rule, 'literalPaths'), 1024).filter((entry) =>
          path(entry, false),
        ),
      });
    }
    return {
      disabled: false,
      valueTestIds: strings(own(input, 'valueTestIds'), 256),
      urlRules,
      launchArgumentKeys: strings(own(input, 'launchArgumentKeys'), 128),
    };
  } catch {
    return defaults(true);
  }
}
