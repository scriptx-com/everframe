// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Opt-in JS-side capture integrations (spec 2026-07-14 RN-iOS parity).
// These are the ONLY sanctioned relaxation of the "JS auto-capture is a
// non-goal" ruling (contextSeam.ts): nothing installs unless the host lists
// it in `config.integrations`, and each integration ships as its own
// subpath export so unused ones never enter the bundle.

/** A host-opt-in capture integration. */
export interface TraceItXIntegration {
  /** Diagnostic name used in warn messages, e.g. 'console'. */
  name: string;
  /**
   * Called at the end of runtime mount (context is published — top-level
   * seam functions work). Return a teardown to run on unmount.
   */
  setup(): (() => void) | void;
}
