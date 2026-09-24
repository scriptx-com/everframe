// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Per CONTEXT.md: sample 20 components on init; if >50% lack a usable displayName,
// console.warn once with link to install docs. Never throw (DEFE-02).

const MANGLED_LIKELY = /^[a-z]$|^_[a-z]\d?$|^[a-z]{1,2}$/;
let _warned = false;

export function sampleAndWarn(displayNames: Array<string | undefined>, sampleSize = 20): void {
  if (_warned) return;
  const sample = displayNames.slice(0, sampleSize);
  if (sample.length === 0) return;
  const mangled = sample.filter((n) => !n || MANGLED_LIKELY.test(n)).length;
  if (mangled / sample.length > 0.5) {
    _warned = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[everframe] More than half of sampled components have no displayName or look minified. ' +
        'Install @everframe/babel-plugin-displayname or @everframe/swc-plugin-displayname for AI-readable reports. ' +
        'See https://github.com/scriptx-com/everframe#displayname-plugin'
    );
  }
}

// Test seam.
export function __resetWarned(): void {
  _warned = false;
}
